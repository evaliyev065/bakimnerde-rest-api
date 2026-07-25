import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, TenantType, UserDocument, UserRole } from "../domain/identity.types.js";
import { verifyPassword } from "../infrastructure/password.js";
import { createToken } from "../infrastructure/token.js";

export class AuthService {
  public constructor(private readonly database: MongoDatabase, private readonly tokenSecret: string) {}

  public platformLogin(email: string, password: string) {
    return this.login(email, password, ["PLATFORM"], ["PLATFORM_OWNER", "PLATFORM_STAFF"]);
  }

  public companyLogin(email: string, password: string) {
    return this.login(email, password, ["CPO", "CONTRACTOR"], ["CPO_ADMIN", "CPO_STAFF", "CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"]);
  }

  public fieldLogin(email: string, password: string) {
    return this.login(email, password, ["CONTRACTOR"], ["FIELD_WORKER"]);
  }

  private async login(email: string, password: string, tenantTypes: TenantType[], roles: UserRole[]): Promise<{ token: string; principal: AuthPrincipal }> {
    const db = await this.database.db();
    const user = await db.collection<UserDocument>("users").findOne({
      emailNormalized: email.trim().toLocaleLowerCase("tr-TR"),
      status: "ACTIVE",
      role: { $in: roles },
    });
    if (user?._id === undefined || !verifyPassword(password, user.passwordHash)) {
      throw new AppError(401, "AUTH_CREDENTIALS_INVALID", "E-posta veya parola hatalı.", false);
    }
    const tenant = await db.collection<TenantDocument>("tenants").findOne({
      _id: user.tenantId, status: "ACTIVE", type: { $in: tenantTypes },
    });
    if (tenant?._id === undefined) throw new AppError(403, "LOGIN_CHANNEL_NOT_ALLOWED", "Bu hesap bu giriş kanalını kullanamaz.", false);
    const principal: AuthPrincipal = {
      userId: user._id.toHexString(), tenantId: tenant._id.toHexString(), tenantKey: tenant.tenantKey,
      tenantName: tenant.name, tenantType: tenant.type, name: user.name, email: user.email, role: user.role,
    };
    await db.collection<UserDocument>("users").updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    return { token: createToken(principal, this.tokenSecret), principal };
  }
}
