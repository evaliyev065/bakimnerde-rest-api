import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, TenantType, UserDocument, UserRole } from "../domain/identity.types.js";
import { hashPassword } from "../infrastructure/password.js";

const TENANT_TYPES = new Set<TenantType>(["CPO", "CONTRACTOR"]);
const PHONE_PATTERN = /^[1-9]\d{9}$/;
const CONTRACTOR_ACTIVITY_AREAS = new Set(["PERIODIC_MAINTENANCE", "ELECTRICAL", "ELECTRONICS", "MECHANICAL", "SOFTWARE", "CHARGER_INSTALLATION"]);
const ADMIN_ROLES: Record<TenantType, UserRole> = {
  PLATFORM: "PLATFORM_OWNER",
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
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantKey: 1, name: 1, type: 1, status: 1, contact: 1, createdAt: 1, updatedAt: 1,
        hasPrivatePolicy: { $gt: [{ $size: { $objectToArray: "$commercialPolicy" } }, 0] },
        profile: { $ifNull: [
          { $first: "$contractorProfile" },
          { $first: "$cpoProfile" },
        ] },
      } },
      { $set: { "profile._id": "$$REMOVE", "profile.tenantId": "$$REMOVE" } },
    ]).toArray();
  }

  public async ownProfile(principal: AuthPrincipal): Promise<Document> {
    const db = await this.database.db();
    const tenantId = new ObjectId(principal.tenantId);
    const tenant = await db.collection("tenants").findOne({ _id: tenantId });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Firma bulunamadı.", false);
    const profile = principal.tenantType === "CONTRACTOR" ? await db.collection("contractorProfiles").findOne({ tenantId }) : null;
    return {
      id: tenantId.toHexString(), name: tenant.name, type: tenant.type,
      serviceRegions: profile?.serviceRegions ?? [],
      activityAreas: profile?.activityAreas ?? profile?.specialties ?? [],
    };
  }

  public async updateOwnCoverage(principal: AuthPrincipal, input: { serviceRegions: string[]; activityAreas: string[] }): Promise<{ id: string }> {
    if (principal.tenantType !== "CONTRACTOR" || principal.role !== "CONTRACTOR_ADMIN") {
      throw new AppError(403, "CONTRACTOR_COVERAGE_FORBIDDEN", "Kapsama alanını yalnız teknik servis yöneticisi güncelleyebilir.", false);
    }
    const serviceRegions = [...new Set((input.serviceRegions ?? []).map((item) => item.trim()).filter(Boolean))];
    const activityAreas = [...new Set((input.activityAreas ?? []).map((item) => item.trim().toUpperCase()).filter(Boolean))];
    if (serviceRegions.length === 0 || serviceRegions.length > 81 || activityAreas.length === 0 || activityAreas.some((item) => !CONTRACTOR_ACTIVITY_AREAS.has(item))) {
      throw new AppError(400, "CONTRACTOR_COVERAGE_INVALID", "Hizmet bölgelerini ve faaliyet alanlarını kontrol edin.", false);
    }
    const tenantId = new ObjectId(principal.tenantId);
    const db = await this.database.db();
    await db.collection("contractorProfiles").updateOne(
      { tenantId },
      { $set: { serviceRegions, activityAreas, specialties: activityAreas, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    return { id: principal.tenantId };
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
        _id: tenantId, tenantKey: normalizedKey, name: input.name.trim(), type: input.type, status: "ACTIVE", operationalStatus: "ACTIVE",
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
          tenantId, type: "CLOSED", currency: "TRY", balance: 0, blockedBalance: 0, creditLimit: 0, debtStatus: "CLEAR", createdAt: now, updatedAt: now,
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
    if (!PHONE_PATTERN.test(input.contactPhone)) {
      throw new AppError(400, "PHONE_INVALID", "Telefon numarası 0 ile başlamayan 10 hane olmalıdır.", false);
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
      { cpoTenantId: id }, { contractorTenantId: id },
    ] });
    if (relatedJobs > 0) {
      throw new AppError(409, "TENANT_HAS_OPERATIONS", "Geçmiş işi bulunan firma silinemez; firmayı askıya alın.", false);
    }
    await Promise.all([
      db.collection("tenants").deleteOne({ _id: id }),
      db.collection("users").deleteMany({ tenantId: id }),
      db.collection("contractorProfiles").deleteMany({ tenantId: id }),
      db.collection("cpoProfiles").deleteMany({ tenantId: id }),
      db.collection("wallets").deleteMany({ tenantId: id }),
      db.collection("pricingRules").deleteMany({ counterpartyTenantId: id }),
    ]);
    return { id: idValue, deleted: true };
  }

  private async upsertProfile(db: Awaited<ReturnType<MongoDatabase["db"]>>, tenantId: ObjectId, type: TenantType, profile: Record<string, unknown>, now: Date): Promise<void> {
    const collection = type === "CONTRACTOR" ? "contractorProfiles" : type === "CPO" ? "cpoProfiles" : null;
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
    if (!PHONE_PATTERN.test(input.contactPhone)) {
      throw new AppError(400, "PHONE_INVALID", "Telefon numarası 0 ile başlamayan 10 hane olmalıdır.", false);
    }
  }
}
