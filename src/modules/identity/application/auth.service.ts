import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, UserDocument } from "../domain/identity.types.js";
import { verifyPassword } from "../infrastructure/password.js";
import { createToken } from "../infrastructure/token.js";

export class AuthService {
  public constructor(
    private readonly database: MongoDatabase,
    private readonly tokenSecret: string,
  ) {}

  public async login(email: string, password: string): Promise<{ token: string; principal: AuthPrincipal }> {
    const db = await this.database.db();
    const user = await db.collection<UserDocument>("users").findOne({
      emailNormalized: email.trim().toLocaleLowerCase("tr-TR"),
      status: "ACTIVE",
    });
    if (user?._id === undefined || !verifyPassword(password, user.passwordHash)) {
      throw new AppError(401, "AUTH_CREDENTIALS_INVALID", "E-posta veya parola hatalı.", false);
    }
    const tenant = await db.collection<TenantDocument>("tenants").findOne({ _id: user.tenantId, status: "ACTIVE" });
    if (tenant?._id === undefined) {
      throw new AppError(403, "TENANT_NOT_ACTIVE", "Şirket hesabı aktif değil.", false);
    }
    const principal: AuthPrincipal = {
      userId: user._id.toHexString(),
      tenantId: tenant._id.toHexString(),
      tenantKey: tenant.tenantKey,
      tenantName: tenant.name,
      tenantType: tenant.type,
      name: user.name,
      email: user.email,
      role: user.role,
    };
    await db.collection<UserDocument>("users").updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    return { token: createToken(principal, this.tokenSecret), principal };
  }
}
