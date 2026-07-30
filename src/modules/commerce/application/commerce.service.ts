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
        tenantType: { $first: "$tenant.type" }, type: 1, currency: 1, balance: 1, blockedBalance: 1, updatedAt: 1,
      } },
    ]).toArray();
  }

  public async adjustWallet(principal: AuthPrincipal, input: { tenantId: string; amount: number; description: string; reference?: string }): Promise<{ transactionId: string; balance: number }> {
    this.assertPlatform(principal);
    if (!Number.isFinite(input.amount) || input.amount === 0 || !input.description?.trim()) {
      throw new AppError(400, "WALLET_ADJUSTMENT_INVALID", "Tutar sıfırdan farklı olmalı ve açıklama girilmelidir.", false);
    }
    const tenantId = this.objectId(input.tenantId);
    const db = await this.database.db();
    const wallet = await db.collection("wallets").findOne({ tenantId });
    if (wallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "Firma cüzdanı bulunamadı.", false);
    const currentBalance = Number(wallet.balance ?? 0);
    const nextBalance = currentBalance + Number(input.amount);
    if (nextBalance < 0) throw new AppError(409, "WALLET_BALANCE_INSUFFICIENT", "İşlem cüzdan bakiyesini eksiye düşüremez.", false);
    const now = new Date();
    const transactionId = new ObjectId();
    await db.collection("wallets").updateOne({ _id: wallet._id }, { $set: { balance: nextBalance, updatedAt: now } });
    await db.collection("walletTransactions").insertOne({
      _id: transactionId, walletId: wallet._id, tenantId, amount: Number(input.amount),
      direction: input.amount > 0 ? "CREDIT" : "DEBIT", description: input.description.trim(),
      reference: input.reference?.trim() ?? "", createdByUserId: new ObjectId(principal.userId), createdAt: now,
    });
    return { transactionId: transactionId.toHexString(), balance: nextBalance };
  }

  public async listWalletTransactions(principal: AuthPrincipal): Promise<Document[]> {
    this.assertWalletReader(principal);
    const db = await this.database.db();
    const match = principal.tenantType === "PLATFORM" ? {} : { tenantId: new ObjectId(principal.tenantId) };
    return db.collection("walletTransactions").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } }, { $limit: 200 },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Bilinmeyen firma"] },
        amount: 1, direction: 1, description: 1, reference: 1, createdAt: 1,
      } },
    ]).toArray();
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
