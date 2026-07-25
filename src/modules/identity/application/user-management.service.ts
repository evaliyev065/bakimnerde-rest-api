import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, TenantType, UserDocument, UserRole } from "../domain/identity.types.js";
import { hashPassword } from "../infrastructure/password.js";

const ROLES_BY_TENANT: Record<TenantType, UserRole[]> = {
  PLATFORM: ["PLATFORM_OWNER", "PLATFORM_STAFF"],
  CPO: ["CPO_ADMIN", "CPO_STAFF"],
  CONTRACTOR: ["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF", "FIELD_WORKER"],
};
const PHONE_PATTERN = /^[1-9]\d{9}$/;

export class UserManagementService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal, type: TenantType): Promise<Document[]> {
    this.assertCategoryAccess(principal, type);
    const db = await this.database.db();
    const match: Document = { role: { $in: ROLES_BY_TENANT[type] } };
    if (principal.tenantType !== "PLATFORM") match.tenantId = new ObjectId(principal.tenantId);
    return db.collection<UserDocument>("users").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Bilinmeyen tenant"] },
        name: 1, email: 1, phone: 1, role: 1, status: 1, lastLoginAt: 1, createdAt: 1,
      } },
    ]).toArray();
  }

  public async create(principal: AuthPrincipal, input: { tenantId?: string; name: string; email: string; phone?: string; role: UserRole; password: string }): Promise<{ id: string }> {
    const tenantId = principal.tenantType === "PLATFORM" ? this.objectId(input.tenantId ?? principal.tenantId) : new ObjectId(principal.tenantId);
    const db = await this.database.db();
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: tenantId, status: "ACTIVE" });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Tenant bulunamadı.", false);
    this.assertCategoryAccess(principal, tenant.type);
    this.validateRole(tenant.type, input.role);
    if (!input.name?.trim() || !input.email?.includes("@") || input.password?.length < 8) {
      throw new AppError(400, "USER_INPUT_INVALID", "Ad, e-posta ve en az 8 karakterli parola gereklidir.", false);
    }
    this.validatePhone(input.phone);
    const now = new Date();
    try {
      const result = await db.collection<UserDocument>("users").insertOne({
        tenantId, name: input.name.trim(), email: input.email.trim(),
        emailNormalized: input.email.trim().toLocaleLowerCase("tr-TR"), phone: input.phone?.trim() ?? "",
        role: input.role, passwordHash: hashPassword(input.password), status: "ACTIVE", createdAt: now, updatedAt: now,
      });
      return { id: result.insertedId.toHexString() };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        throw new AppError(409, "USER_EMAIL_EXISTS", "Bu e-posta adresi zaten kullanılıyor.", false);
      }
      throw error;
    }
  }

  public async update(principal: AuthPrincipal, input: { id: string; name: string; email: string; phone?: string; role: UserRole; status: "ACTIVE" | "SUSPENDED"; password?: string }): Promise<{ id: string }> {
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const user = await db.collection<UserDocument>("users").findOne({ _id: id });
    if (user === null) throw new AppError(404, "USER_NOT_FOUND", "Kullanıcı bulunamadı.", false);
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: user.tenantId });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Tenant bulunamadı.", false);
    this.assertCategoryAccess(principal, tenant.type);
    this.validateRole(tenant.type, input.role);
    if (user.role === "PLATFORM_OWNER" && input.role !== "PLATFORM_OWNER") {
      throw new AppError(409, "PLATFORM_OWNER_PROTECTED", "Ana Bakımnerde hesabının rolü değiştirilemez.", false);
    }
    if (principal.userId === input.id && input.status !== "ACTIVE") {
      throw new AppError(409, "CURRENT_USER_PROTECTED", "Açık oturumdaki hesabı askıya alamazsınız.", false);
    }
    this.validatePhone(input.phone);
    const set: Record<string, unknown> = {
      name: input.name.trim(), email: input.email.trim(), emailNormalized: input.email.trim().toLocaleLowerCase("tr-TR"),
      phone: input.phone?.trim() ?? "", role: input.role, status: input.status, updatedAt: new Date(),
    };
    if (input.password) {
      if (input.password.length < 8) throw new AppError(400, "PASSWORD_TOO_SHORT", "Parola en az 8 karakter olmalıdır.", false);
      set.passwordHash = hashPassword(input.password);
    }
    await db.collection<UserDocument>("users").updateOne({ _id: id }, { $set: set });
    return { id: input.id };
  }

  public async delete(principal: AuthPrincipal, idValue: string): Promise<{ id: string; deleted: true }> {
    if (principal.userId === idValue) throw new AppError(409, "CURRENT_USER_PROTECTED", "Açık oturumdaki hesabı silemezsiniz.", false);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const user = await db.collection<UserDocument>("users").findOne({ _id: id });
    if (user === null) throw new AppError(404, "USER_NOT_FOUND", "Kullanıcı bulunamadı.", false);
    if (user.role === "PLATFORM_OWNER") throw new AppError(409, "PLATFORM_OWNER_PROTECTED", "Ana Bakımnerde hesabı silinemez.", false);
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: user.tenantId });
    if (tenant === null) throw new AppError(404, "TENANT_NOT_FOUND", "Tenant bulunamadı.", false);
    this.assertCategoryAccess(principal, tenant.type);
    await db.collection<UserDocument>("users").deleteOne({ _id: id });
    return { id: idValue, deleted: true };
  }

  private assertCategoryAccess(principal: AuthPrincipal, type: TenantType): void {
    if (principal.tenantType === "PLATFORM") return;
    const adminRole = principal.tenantType === "CPO" ? "CPO_ADMIN" : "CONTRACTOR_ADMIN";
    if (principal.tenantType !== type || principal.role !== adminRole) {
      throw new AppError(403, "USER_MANAGEMENT_FORBIDDEN", "Bu kullanıcı grubunu yönetme yetkiniz yok.", false);
    }
  }

  private validateRole(type: TenantType, role: UserRole): void {
    if (!ROLES_BY_TENANT[type].includes(role)) throw new AppError(400, "USER_ROLE_INVALID", "Rol tenant türüyle uyumlu değil.", false);
  }

  private validatePhone(phone: string | undefined): void {
    if (phone && !PHONE_PATTERN.test(phone)) {
      throw new AppError(400, "PHONE_INVALID", "Telefon numarası 0 ile başlamayan 10 hane olmalıdır.", false);
    }
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }
}
