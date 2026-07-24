import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `scrypt:${salt}:${digest}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, digest] = stored.split(":");
  if (algorithm !== "scrypt" || salt === undefined || digest === undefined) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
