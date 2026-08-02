import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionPayload = {
  userId: string;
  orgId: string;
  email: string;
  expiresAt: string;
};

type CookieOptions = {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
};

const sessionCookieName = "pagelet_session";
const oauthStateCookieName = "pagelet_oauth_state";
const sessionMaxAgeSeconds = 12 * 60 * 60;
const oauthStateMaxAgeSeconds = 10 * 60;

export function createSessionPayload(input: {
  userId: string;
  orgId: string;
  email: string;
  now?: Date;
}): SessionPayload {
  const now = input.now ?? new Date();

  return {
    userId: input.userId,
    orgId: input.orgId,
    email: input.email,
    expiresAt: new Date(now.getTime() + sessionMaxAgeSeconds * 1000).toISOString()
  };
}

export function createSessionCookie(
  payload: SessionPayload,
  options: Pick<CookieOptions, "secure"> = {}
): string {
  return serializeCookie(sessionCookieName, signPayload(payload), {
    httpOnly: true,
    maxAgeSeconds: sessionMaxAgeSeconds,
    path: "/",
    sameSite: "Lax",
    secure: options.secure
  });
}

export function clearSessionCookie(): string {
  return serializeCookie(sessionCookieName, "", {
    httpOnly: true,
    maxAgeSeconds: 0,
    path: "/",
    sameSite: "Lax"
  });
}

export function readSessionPayload(request: Request): SessionPayload | null {
  const signedValue = readCookie(request, sessionCookieName);

  if (!signedValue) {
    return null;
  }

  const payload = verifySignedPayload<SessionPayload>(signedValue);

  if (!payload || Date.parse(payload.expiresAt) <= Date.now()) {
    return null;
  }

  return payload;
}

export function createOAuthStateCookie(
  state: string,
  options: Pick<CookieOptions, "secure"> = {}
): string {
  return serializeCookie(oauthStateCookieName, state, {
    httpOnly: true,
    maxAgeSeconds: oauthStateMaxAgeSeconds,
    path: "/auth/google",
    sameSite: "Lax",
    secure: options.secure
  });
}

export function clearOAuthStateCookie(): string {
  return serializeCookie(oauthStateCookieName, "", {
    httpOnly: true,
    maxAgeSeconds: 0,
    path: "/auth/google",
    sameSite: "Lax"
  });
}

export function readOAuthStateCookie(request: Request): string | null {
  return readCookie(request, oauthStateCookieName);
}

export function signPayload(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body)}`;
}

export function verifySignedPayload<T>(signedValue: string): T | null {
  const [body, actualSignature] = signedValue.split(".");

  if (!body || !actualSignature) {
    return null;
  }

  const expectedSignature = signature(body);

  if (!timingSafeEqualString(actualSignature, expectedSignature)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");

  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (rawName === name) {
      return rawValue.join("=") || null;
    }
  }

  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions
): string {
  const parts = [`${name}=${value}`];

  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  parts.push(`Path=${options.path ?? "/"}`);

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function signature(body: string): string {
  return createHmac("sha256", sessionSecret()).update(body).digest("base64url");
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }

  return "dev-session-secret";
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
