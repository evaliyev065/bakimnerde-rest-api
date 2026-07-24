import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../../../config/env.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../domain/identity.types.js";
import { verifyToken } from "../infrastructure/token.js";

export interface AuthenticatedResponse extends Response {
  locals: { auth: AuthPrincipal };
}

export function authenticate(config: AppConfig): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      next(new AppError(401, "AUTH_TOKEN_REQUIRED", "Oturum açmanız gerekiyor.", false));
      return;
    }
    try {
      response.locals.auth = verifyToken(authorization.slice(7), config.authTokenSecret);
      next();
    } catch (error) {
      next(error);
    }
  };
}
