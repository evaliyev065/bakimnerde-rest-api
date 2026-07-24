import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../domain/identity.types.js";

interface TokenPayload extends AuthPrincipal {
  exp: number;
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createToken(principal: AuthPrincipal, secret: string): string {
  const encoded = Buffer.from(JSON.stringify({ ...principal, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyToken(token: string, secret: string): AuthPrincipal {
  const [encoded, suppliedSignature] = token.split(".");
  if (encoded === undefined || suppliedSignature === undefined) throw unauthorized();
  const expected = signature(encoded, secret);
  const valid = expected.length === suppliedSignature.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(suppliedSignature));
  if (!valid) throw unauthorized();
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
    if (payload.exp < Date.now()) throw unauthorized();
    const { exp: _expiresAt, ...principal } = payload;
    return principal;
  } catch {
    throw unauthorized();
  }
}

function unauthorized(): AppError {
  return new AppError(401, "AUTH_TOKEN_INVALID", "Oturum geçersiz veya süresi dolmuş.", false);
}
