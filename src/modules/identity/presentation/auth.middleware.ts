import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ObjectId } from "mongodb";
import type { AppConfig } from "../../../config/env.js";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../domain/identity.types.js";
import { verifyToken } from "../infrastructure/token.js";

export interface AuthenticatedResponse extends Response {
  locals: { auth: AuthPrincipal };
}

export function authenticate(config: AppConfig, database?: MongoDatabase): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      next(new AppError(401, "AUTH_TOKEN_REQUIRED", "Oturum açmanız gerekiyor.", false));
      return;
    }
    try {
      const principal = verifyToken(authorization.slice(7), config.authTokenSecret);
      if (database) {
        const db = await database.db();
        const tenantId = new ObjectId(principal.tenantId);
        const [tenant, user, wallet] = await Promise.all([
          db.collection("tenants").findOne({ _id: tenantId, status: "ACTIVE", type: principal.tenantType }),
          db.collection("users").findOne({
            _id: new ObjectId(principal.userId), tenantId, status: "ACTIVE", role: principal.role,
          }),
          principal.tenantType === "CPO" ? db.collection("wallets").findOne({ tenantId }) : Promise.resolve(null),
        ]);
        if (tenant === null || user === null) throw unauthorizedCurrentState();
        if (principal.tenantType === "CPO") {
          const debtBlocked = wallet === null
            ? tenant.operationalStatus === "DEBT_BLOCKED"
            : Number(wallet.balance ?? 0) < -Math.max(0, Number(wallet.creditLimit ?? 0));
          const operationalStatus = debtBlocked ? "DEBT_BLOCKED" : "ACTIVE";
          if (tenant.operationalStatus !== operationalStatus) {
            await db.collection("tenants").updateOne({ _id: tenantId }, { $set: { operationalStatus, updatedAt: new Date() } });
          }
          if (debtBlocked) {
            throw new AppError(403, "CPO_DEBT_BLOCKED", "Borçlanma limiti aşıldığı için CPO hesabı kullanıma kapatıldı.", false);
          }
        }
      }
      response.locals.auth = principal;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function unauthorizedCurrentState(): AppError {
  return new AppError(401, "AUTH_PRINCIPAL_INACTIVE", "Kullanıcı veya firma hesabı artık aktif değil.", false);
}
