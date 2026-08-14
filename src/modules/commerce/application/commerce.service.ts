import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

interface PriceInput {
  id?: string;
  itemCode: string;
  itemName: string;
  category: string;
  cost: number;
  salePrice: number;
  currency?: string;
  supplyType: string;
  counterpartyTenantId?: string;
  active?: boolean;
}

export class CommerceService {
  public constructor(private readonly database: MongoDatabase) {}

  public async listPrices(principal: AuthPrincipal): Promise<Document[]> {
    this.assertPlatform(principal);
    const db = await this.database.db();
    return db.collection("pricingRules").aggregate([
      { $sort: { updatedAt: -1 } },
      { $lookup: { from: "tenants", localField: "counterpartyTenantId", foreignField: "_id", as: "counterparty" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, itemCode: 1, itemName: 1, category: 1, cost: 1,
        salePrice: 1, currency: 1, supplyType: 1, active: 1,
        counterpartyTenantId: { $cond: [{ $ifNull: ["$counterpartyTenantId", false] }, { $toString: "$counterpartyTenantId" }, null] },
        counterpartyName: { $ifNull: [{ $first: "$counterparty.name" }, "Standart fiyat"] },
      } },
    ]).toArray();
  }

  public async createPrice(principal: AuthPrincipal, input: PriceInput): Promise<{ id: string }> {
    this.assertPlatform(principal);
    this.validatePrice(input);
    const db = await this.database.db();
    const now = new Date();
    const result = await db.collection("pricingRules").insertOne({
      ownerTenantId: new ObjectId(principal.tenantId),
      counterpartyTenantId: input.counterpartyTenantId ? this.objectId(input.counterpartyTenantId) : null,
      itemCode: input.itemCode.trim().toUpperCase(), itemName: input.itemName.trim(), category: input.category.trim(),
      cost: Number(input.cost), salePrice: Number(input.salePrice), currency: input.currency ?? "TRY",
      supplyType: input.supplyType.trim(), visibleToCounterparty: false, active: input.active ?? true,
      createdAt: now, updatedAt: now,
    });
    return { id: result.insertedId.toHexString() };
  }

  public async updatePrice(principal: AuthPrincipal, input: PriceInput): Promise<{ id: string }> {
    this.assertPlatform(principal);
    this.validatePrice(input);
    const id = this.objectId(input.id ?? "");
    const db = await this.database.db();
    const result = await db.collection("pricingRules").updateOne({ _id: id }, { $set: {
      counterpartyTenantId: input.counterpartyTenantId ? this.objectId(input.counterpartyTenantId) : null,
      itemCode: input.itemCode.trim().toUpperCase(), itemName: input.itemName.trim(), category: input.category.trim(),
      cost: Number(input.cost), salePrice: Number(input.salePrice), currency: input.currency ?? "TRY",
      supplyType: input.supplyType.trim(), active: input.active ?? true, updatedAt: new Date(),
    } });
    if (result.matchedCount === 0) throw new AppError(404, "PRICE_NOT_FOUND", "Fiyat kaydı bulunamadı.", false);
    return { id: id.toHexString() };
  }

  public async deletePrice(principal: AuthPrincipal, idValue: string): Promise<{ id: string; deleted: true }> {
    this.assertPlatform(principal);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const result = await db.collection("pricingRules").deleteOne({ _id: id });
    if (result.deletedCount === 0) throw new AppError(404, "PRICE_NOT_FOUND", "Fiyat kaydı bulunamadı.", false);
    return { id: idValue, deleted: true };
  }

  public async listWallets(principal: AuthPrincipal): Promise<Document[]> {
    this.assertWalletReader(principal);
    const db = await this.database.db();
    const match = principal.tenantType === "PLATFORM" ? {} : { tenantId: new ObjectId(principal.tenantId) };
    return db.collection("wallets").aggregate([
      { $match: match },
      { $sort: { updatedAt: -1 } },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Bilinmeyen firma"] },
        tenantType: { $first: "$tenant.type" }, type: 1, currency: 1, balance: 1, blockedBalance: 1,
        creditLimit: { $ifNull: ["$creditLimit", 0] },
        debtAmount: { $cond: [{ $lt: [{ $ifNull: ["$balance", 0] }, 0] }, { $multiply: [{ $ifNull: ["$balance", 0] }, -1] }, 0] },
        borrowableAmount: { $cond: [
          { $gt: [{ $add: [{ $ifNull: ["$creditLimit", 0] }, { $cond: [{ $lt: [{ $ifNull: ["$balance", 0] }, 0] }, { $ifNull: ["$balance", 0] }, 0] }] }, 0] },
          { $add: [{ $ifNull: ["$creditLimit", 0] }, { $cond: [{ $lt: [{ $ifNull: ["$balance", 0] }, 0] }, { $ifNull: ["$balance", 0] }, 0] }] },
          0,
        ] },
        debtStatus: { $ifNull: ["$debtStatus", { $cond: [{ $lt: [{ $ifNull: ["$balance", 0] }, 0] }, "IN_DEBT", "CLEAR"] }] },
        updatedAt: 1,
      } },
    ]).toArray();
  }

  public async adjustWallet(
    principal: AuthPrincipal,
    input: { tenantId: string; amount: number; description: string; paymentMethod?: "MANUAL" | "WALLET" | "CREDIT_CARD" },
  ): Promise<{ transactionId: string; balance: number }> {
    this.assertPlatform(principal);
    if (!Number.isFinite(input.amount) || input.amount === 0 || !input.description?.trim()) {
      throw new AppError(400, "WALLET_ADJUSTMENT_INVALID", "Tutar sıfırdan farklı olmalı ve açıklama girilmelidir.", false);
    }
    const paymentMethod = input.paymentMethod ?? "MANUAL";
    if (!["MANUAL", "WALLET", "CREDIT_CARD"].includes(paymentMethod)) {
      throw new AppError(400, "PAYMENT_METHOD_INVALID", "Geçersiz ödeme yöntemi.", false);
    }
    const tenantId = this.objectId(input.tenantId);
    const db = await this.database.db();
    const wallet = await db.collection("wallets").findOne({ tenantId });
    if (wallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "Firma cüzdanı bulunamadı.", false);
    const tenant = await db.collection("tenants").findOne({ _id: tenantId });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Firma bulunamadı.", false);
    const amount = Number(input.amount);
    const now = new Date();
    const transactionId = new ObjectId();
    const minimumBalanceExpression: Document | number = tenant.type === "CPO"
      ? { $multiply: [-1, { $ifNull: ["$creditLimit", 0] }] }
      : 0;
    const walletFilter: Document = { _id: wallet._id };
    if (amount < 0) {
      walletFilter.$expr = { $gte: [
        { $add: [{ $ifNull: ["$balance", 0] }, amount] },
        minimumBalanceExpression,
      ] };
    }
    const walletUpdate = await db.collection("wallets").updateOne(
      walletFilter,
      [
        { $set: { balance: { $add: [{ $ifNull: ["$balance", 0] }, amount] }, updatedAt: now } },
        { $set: { debtStatus: { $cond: [
          { $lt: ["$balance", minimumBalanceExpression] },
          "DEBT_LIMIT_EXCEEDED",
          { $cond: [{ $lt: ["$balance", 0] }, "IN_DEBT", "CLEAR"] },
        ] } } },
      ],
    );
    if (walletUpdate.matchedCount === 0) {
      throw new AppError(409, "CPO_CREDIT_LIMIT_EXCEEDED", "İşlem tanımlı bakiye ve borçlanma limitini aşamaz.", false);
    }
    const updatedWallet = await db.collection("wallets").findOne({ _id: wallet._id });
    if (updatedWallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "Firma cüzdanı bulunamadı.", true);
    const nextBalance = Number(updatedWallet.balance ?? 0);
    const creditLimit = tenant.type === "CPO" ? Math.max(0, Number(updatedWallet.creditLimit ?? 0)) : 0;
    if (tenant.type === "CPO") {
      await db.collection("tenants").updateOne({ _id: tenantId }, { $set: {
        operationalStatus: nextBalance < -creditLimit ? "DEBT_BLOCKED" : "ACTIVE", updatedAt: now,
      } });
    }
    await db.collection("walletTransactions").insertOne({
      _id: transactionId, walletId: wallet._id, tenantId, amount,
      type: "MANUAL_ADJUSTMENT", paymentMethod, currency: String(wallet.currency ?? "TRY"),
      direction: amount > 0 ? "CREDIT" : "DEBIT", description: input.description.trim(),
      createdByUserId: new ObjectId(principal.userId), createdAt: now,
    });
    return { transactionId: transactionId.toHexString(), balance: nextBalance };
  }

  public async listWalletTransactions(principal: AuthPrincipal): Promise<Document[]> {
    this.assertWalletReader(principal);
    const db = await this.database.db();
    const match = principal.tenantType === "PLATFORM" ? {} : { tenantId: new ObjectId(principal.tenantId) };
    return db.collection("walletTransactions").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Bilinmeyen firma"] },
        amount: 1, direction: 1, description: 1, createdAt: 1, currency: 1, type: 1,
        paymentMethod: { $ifNull: ["$paymentMethod", { $cond: [
          { $eq: [{ $ifNull: ["$type", "MANUAL_ADJUSTMENT"] }, "MANUAL_ADJUSTMENT"] }, "MANUAL", "WALLET",
        ] }] },
        jobId: { $cond: [{ $ifNull: ["$jobId", false] }, { $toString: "$jobId" }, null] },
        jobNumber: { $ifNull: [{ $first: "$job.jobNumber" }, null] },
      } },
    ]).toArray();
  }

  public async walletTransactionDetail(principal: AuthPrincipal, idValue: string): Promise<Document> {
    this.assertWalletReader(principal);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const match: Document = { _id: id };
    if (principal.tenantType !== "PLATFORM") match.tenantId = new ObjectId(principal.tenantId);
    const rows = await db.collection("walletTransactions").aggregate([
      { $match: match },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Bilinmeyen firma"] },
        jobId: { $cond: [{ $ifNull: ["$jobId", false] }, { $toString: "$jobId" }, null] },
        jobNumber: { $ifNull: [{ $first: "$job.jobNumber" }, null] },
        walletId: { $cond: [{ $ifNull: ["$walletId", false] }, { $toString: "$walletId" }, null] },
        type: { $ifNull: ["$type", "MANUAL_ADJUSTMENT"] },
        paymentMethod: { $ifNull: ["$paymentMethod", { $cond: [
          { $eq: [{ $ifNull: ["$type", "MANUAL_ADJUSTMENT"] }, "MANUAL_ADJUSTMENT"] }, "MANUAL", "WALLET",
        ] }] },
        paymentReference: { $ifNull: ["$paymentReference", null] }, cardSummary: { $ifNull: ["$cardSummary", null] },
        amount: 1, direction: 1, currency: { $ifNull: ["$currency", "TRY"] }, description: 1, createdAt: 1,
      } },
      { $limit: 1 },
    ]).toArray();
    if (rows[0] === undefined) throw new AppError(404, "WALLET_TRANSACTION_NOT_FOUND", "Ödeme kaydı bulunamadı.", false);
    return rows[0];
  }

  public async updateCreditLimit(
    principal: AuthPrincipal,
    input: { tenantId: string; creditLimit: number },
  ): Promise<{ tenantId: string; creditLimit: number; borrowableAmount: number; debtStatus: string }> {
    this.assertPlatform(principal);
    const tenantId = this.objectId(input.tenantId);
    const creditLimit = Number(input.creditLimit);
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      throw new AppError(400, "CREDIT_LIMIT_INVALID", "Borçlanma limiti sıfır veya daha büyük olmalıdır.", false);
    }
    const db = await this.database.db();
    const tenant = await db.collection("tenants").findOne({ _id: tenantId, type: "CPO" });
    if (tenant === null) throw new AppError(400, "CPO_TENANT_INVALID", "Borçlanma limiti yalnız CPO firması için tanımlanabilir.", false);
    const wallet = await db.collection("wallets").findOne({ tenantId });
    if (wallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "CPO cüzdanı bulunamadı.", false);
    const now = new Date();
    await db.collection("wallets").updateOne(
      { _id: wallet._id },
      [
        { $set: { creditLimit, updatedAt: now } },
        { $set: { debtStatus: { $cond: [
          { $lt: [{ $ifNull: ["$balance", 0] }, -creditLimit] },
          "DEBT_LIMIT_EXCEEDED",
          { $cond: [{ $lt: [{ $ifNull: ["$balance", 0] }, 0] }, "IN_DEBT", "CLEAR"] },
        ] } } },
      ],
    );
    const updatedWallet = await db.collection("wallets").findOne({ _id: wallet._id });
    if (updatedWallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "CPO cüzdanı bulunamadı.", true);
    const balance = Number(updatedWallet.balance ?? 0);
    const debtStatus = balance < -creditLimit ? "DEBT_LIMIT_EXCEEDED" : balance < 0 ? "IN_DEBT" : "CLEAR";
    const borrowableAmount = Math.max(0, creditLimit + Math.min(balance, 0));
    await db.collection("tenants").updateOne({ _id: tenantId }, { $set: {
      operationalStatus: debtStatus === "DEBT_LIMIT_EXCEEDED" ? "DEBT_BLOCKED" : "ACTIVE", updatedAt: now,
    } });
    return { tenantId: input.tenantId, creditLimit, borrowableAmount, debtStatus };
  }

  private validatePrice(input: PriceInput): void {
    if (!input.itemCode?.trim() || !input.itemName?.trim() || !input.category?.trim() || !input.supplyType?.trim()
      || !Number.isFinite(Number(input.cost)) || !Number.isFinite(Number(input.salePrice)) || Number(input.cost) < 0 || Number(input.salePrice) < 0) {
      throw new AppError(400, "PRICE_INPUT_INVALID", "Fiyat kalemi alanlarını ve tutarları kontrol edin.", false);
    }
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }

  private assertPlatform(principal: AuthPrincipal): void {
    if (principal.tenantType !== "PLATFORM") throw new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Bu işlem yalnız Bakımnerde personeline açıktır.", false);
  }

  private assertWalletReader(principal: AuthPrincipal): void {
    const companyRoles = ["CPO_ADMIN", "CPO_STAFF", "CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"];
    if (principal.tenantType !== "PLATFORM" && !companyRoles.includes(principal.role)) {
      throw new AppError(403, "WALLET_ACCESS_FORBIDDEN", "Cüzdan yalnız şirket yönetim hesaplarına açıktır.", false);
    }
  }
}
