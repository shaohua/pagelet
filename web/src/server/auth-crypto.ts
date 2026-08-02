import { createHash, randomBytes } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createUserCode(): string {
  return `${randomBytes(3).toString("base64url").toUpperCase()}-${randomBytes(3)
    .toString("base64url")
    .toUpperCase()}`;
}

export function createCliToken(): string {
  return `pltk_${randomBytes(24).toString("base64url")}`;
}

export function normalizeUserCode(userCode: string): string {
  return userCode.trim().toUpperCase();
}
