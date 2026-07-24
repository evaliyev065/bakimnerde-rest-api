import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, TenantType, UserDocument, UserRole } from "../domain/identity.types.js";
import { hashPassword } from "../infrastructure/password.js";

const TENANT_TYPES = new Set<TenantType>(["PLATFORM", "MANUFACTURER", "CPO", "CONTRACTOR"]);
const ADMIN_ROLES: Record<TenantType, UserRole> = {
  PLATFORM: "PLATFORM_ADMIN",
  MANUFACTURER: "MANUFACTURER_ADMIN",
  CPO: "CPO_ADMIN",
  CONTRACTOR: "CONTRACTOR_ADMIN",
};

export interface CreateTenantInput {
  name: string;
  tenantKey: string;
  type: TenantType;
  contactEmail: string;
  contactPhone: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  profile?: Record<string, unknown>;
}

export interface UpdateTenantInput {
  id: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  status: "ACTIVE" | "SUSPENDED";
  profile?: Record<string, unknown>;
}

export class TenantService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal): Promise<Document[]> {
    this.assertPlatform(principal);
    const db = await this.database.db();
    return db.collection<TenantDocument>("tenants").aggregate([
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "contractorProfiles", localField: "_id", foreignField: "tenantId", as: "contractorProfile" } },
      { $lookup: { from: "cpoProfiles", localField: "_id", foreignField: "tenantId", as: "cpoProfile" } },
      { $lookup: { from: "manufacturerProfiles", localField: "_id", foreignField: "tenantId", as: "manufacturerProfile" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantKey: 1, name: 1, type: 1, status: 1, contact: 1, createdAt: 1, updatedAt: 1,
        hasPrivatePolicy: { $gt: [{ $size: { $objectToArray: "$commercialPolicy" } }, 0] },
        profile: { $ifNull: [
          { $first: "$contractorProfile" },
          { $ifNull: [{ $first: "$cpoProfile" }, { $first: "$manufacturerProfile" }] },
        ] },
      } },
      { $set: { "profile._id": "$$REMOVE", "profile.tenantId": "$$REMOVE" } },
    ]).toArray();
  }

  public async create(principal: AuthPrincipal, input: CreateTenantInput): Promise<{ id: string; tenantKey: string }> {
    this.assertPlatform(principal);
    this.validateCreate(input);
    const db = await this.database.db();
    const now = new Date();
    const tenantId = new ObjectId();
    const normalizedKey = input.tenantKey.trim().toLocaleLowerCase("tr-TR").replace(/[^a-z0-9-]/g, "-");
    try {
      await db.collection<TenantDocument>("tenants").insertOne({
        _id: tenantId, tenantKey: normalizedKey, name: input.name.trim(), type: input.type, status: "ACTIVE",
        contact: { email: input.contactEmail.trim(), phone: input.contactPhone.trim() },
        commercialPolicy: {}, createdAt: now, updatedAt: now,
      });
      await db.collection<UserDocument>("users").insertOne({
        _id: new ObjectId(), tenantId, email: input.adminEmail.trim(),
        emailNormalized: input.adminEmail.trim().toLocaleLowerCase("tr-TR"), name: input.adminName.trim(),
        passwordHash: hashPassword(input.adminPassword), role: ADMIN_ROLES[input.type],
        status: "ACTIVE", createdAt: now, updatedAt: now,
      });
      await this.upsertProfile(db, tenantId, input.type, input.profile ?? {}, now);
      if (input.type === "CPO" || input.type === "CONTRACTOR") {
        await db.collection("wallets").insertOne({
          tenantId, type: "CLOSED", currency: "TRY", balance: 0, blockedBalance: 0, createdAt: now, updatedAt: now,
        });
      }
    } catch (error) {
      await Promise.all([
        db.collection("tenants").deleteOne({ _id: tenantId }),
        db.collection("users").deleteMany({ tenantId }),
        db.collection("wallets").deleteMany({ tenantId }),
      ]);
      if (error instanceof Error && "code" in error && error.code === 11000) {
        throw new AppError(409, "TENANT_ALREADY_EXISTS", "Tenant anahtarı veya yönetici e-postası zaten kayıtlı.", false);
      }
      throw error;
    }
    return { id: tenantId.toHexString(), tenantKey: normalizedKey };
  }

  public async update(principal: AuthPrincipal, input: UpdateTenantInput): Promise<{ id: string }> {
    this.assertPlatform(principal);
    const id = this.objectId(input.id);
    if (!input.name?.trim() || !input.contactEmail?.includes("@") || !["ACTIVE", "SUSPENDED"].includes(input.status)) {
      throw new AppError(400, "TENANT_UPDATE_INVALID", "Firma adı, e-posta ve durum alanlarını kontrol edin.", false);
    }
    const db = await this.database.db();
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: id });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Firma bulunamadı.", false);
    if (tenant.type === "PLATFORM" && input.status !== "ACTIVE") {
      throw new AppError(409, "PLATFORM_TENANT_PROTECTED", "Bakımnerde merkez tenantı askıya alınamaz.", false);
    }
    const now = new Date();
    await db.collection<TenantDocument>("tenants").updateOne({ _id: id }, { $set: {
      name: input.name.trim(), contact: { email: input.contactEmail.trim(), phone: input.contactPhone?.trim() ?? "" },
      status: input.status, updatedAt: now,
    } });
    await db.collection<UserDocument>("users").updateMany({ tenantId: id }, { $set: { status: input.status, updatedAt: now } });
    await this.upsertProfile(db, id, tenant.type, input.profile ?? {}, now);
    return { id: input.id };
  }

  public async delete(principal: AuthPrincipal, idValue: string): Promise<{ id: string; deleted: true }> {
    this.assertPlatform(principal);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: id });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Firma bulunamadı.", false);
    if (tenant.type === "PLATFORM") throw new AppError(409, "PLATFORM_TENANT_PROTECTED", "Bakımnerde merkez tenantı silinemez.", false);
    const relatedJobs = await db.collection("jobs").countDocuments({ $or: [
      { cpoTenantId: id }, { manufacturerTenantId: id }, { contractorTenantId: id },
    ] });
    if (relatedJobs > 0) {
      throw new AppError(409, "TENANT_HAS_OPERATIONS", "Geçmiş işi bulunan firma silinemez; firmayı askıya alın.", false);
    }
    await Promise.all([
      db.collection("tenants").deleteOne({ _id: id }),
      db.collection("users").deleteMany({ tenantId: id }),
      db.collection("contractorProfiles").deleteMany({ tenantId: id }),
      db.collection("cpoProfiles").deleteMany({ tenantId: id }),
      db.collection("manufacturerProfiles").deleteMany({ tenantId: id }),
      db.collection("wallets").deleteMany({ tenantId: id }),
      db.collection("pricingRules").deleteMany({ counterpartyTenantId: id }),
    ]);
    return { id: idValue, deleted: true };
  }

  private async upsertProfile(db: Awaited<ReturnType<MongoDatabase["db"]>>, tenantId: ObjectId, type: TenantType, profile: Record<string, unknown>, now: Date): Promise<void> {
    const collection = type === "CONTRACTOR" ? "contractorProfiles" : type === "CPO" ? "cpoProfiles" : type === "MANUFACTURER" ? "manufacturerProfiles" : null;
    if (collection === null) return;
    await db.collection(collection).updateOne({ tenantId }, { $set: { ...profile, tenantId, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }

  private assertPlatform(principal: AuthPrincipal): void {
    if (principal.tenantType !== "PLATFORM" || !principal.role.startsWith("PLATFORM_")) {
      throw new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Bu işlem yalnız Bakımnerde personeline açıktır.", false);
    }
  }

  private validateCreate(input: CreateTenantInput): void {
    if (!input.name?.trim() || !input.tenantKey?.trim() || !TENANT_TYPES.has(input.type)
      || !input.adminName?.trim() || !input.adminEmail?.includes("@") || input.adminPassword?.length < 8) {
      throw new AppError(400, "TENANT_INPUT_INVALID", "Tenant ve yönetici bilgilerini eksiksiz girin; parola en az 8 karakter olmalıdır.", false);
    }
  }
}
