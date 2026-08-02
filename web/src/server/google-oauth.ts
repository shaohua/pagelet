import { randomBytes } from "node:crypto";
import { signPayload, verifySignedPayload } from "./session";

export type GoogleProfile = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

type OAuthStatePayload = {
  nonce: string;
  returnTo: string;
  expiresAt: string;
};

type TokenResponse = {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const userInfoEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";
const oauthStateMaxAgeMs = 10 * 60 * 1000;
const scopes = ["openid", "email", "profile"];

export function createOAuthState(input: {
  appBaseUrl: string;
  returnTo: string | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const payload: OAuthStatePayload = {
    nonce: randomBytes(16).toString("base64url"),
    returnTo: normalizeReturnTo(input.returnTo, input.appBaseUrl),
    expiresAt: new Date(now.getTime() + oauthStateMaxAgeMs).toISOString()
  };

  return signPayload(payload);
}

export function verifyOAuthState(state: string): { returnTo: string } | null {
  const payload = verifySignedPayload<OAuthStatePayload>(state);

  if (!payload || Date.parse(payload.expiresAt) <= Date.now()) {
    return null;
  }

  return { returnTo: payload.returnTo };
}

export function buildGoogleAuthorizationUrl(input: {
  appBaseUrl: string;
  state: string;
}): string {
  const url = new URL(authorizationEndpoint);

  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri(input.appBaseUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);

  return url.toString();
}

export async function exchangeGoogleCode(
  code: string,
  appBaseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: googleRedirectUri(appBaseUrl)
    })
  });
  const body = (await response.json()) as TokenResponse;

  if (!response.ok || typeof body.access_token !== "string") {
    throw new Response("Google token exchange failed", { status: 401 });
  }

  return body.access_token;
}

export async function fetchGoogleProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<GoogleProfile> {
  const response = await fetchImpl(userInfoEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Response("Google profile fetch failed", { status: 401 });
  }

  return normalizeGoogleProfile((await response.json()) as unknown);
}

export function normalizeGoogleProfile(raw: unknown): GoogleProfile {
  if (!raw || typeof raw !== "object") {
    throw new Response("Google profile is invalid", { status: 401 });
  }

  const profile = raw as {
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
    picture?: unknown;
  };

  if (typeof profile.email !== "string" || !profile.email.includes("@")) {
    throw new Response("Google profile email is missing", { status: 401 });
  }

  if (profile.email_verified !== true) {
    throw new Response("Google email is not verified", { status: 403 });
  }

  return {
    email: profile.email.trim().toLowerCase(),
    name: typeof profile.name === "string" && profile.name ? profile.name : null,
    avatarUrl:
      typeof profile.picture === "string" && profile.picture
        ? profile.picture
        : null
  };
}

export function normalizeReturnTo(
  rawReturnTo: string | null,
  appBaseUrl: string
): string {
  if (!rawReturnTo) {
    return "/";
  }

  if (rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")) {
    return rawReturnTo;
  }

  try {
    const appOrigin = new URL(appBaseUrl).origin;
    const returnToUrl = new URL(rawReturnTo);

    if (returnToUrl.origin === appOrigin) {
      return `${returnToUrl.pathname}${returnToUrl.search}${returnToUrl.hash}`;
    }
  } catch {
    return "/";
  }

  return "/";
}

export function googleRedirectUri(appBaseUrl: string): string {
  return `${new URL(appBaseUrl).origin}/auth/google/callback`;
}

function googleClientId(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();

  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is required for Google OAuth");
  }

  return clientId;
}

function googleClientSecret(): string {
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientSecret) {
    throw new Error("GOOGLE_CLIENT_SECRET is required for Google OAuth");
  }

  return clientSecret;
}
