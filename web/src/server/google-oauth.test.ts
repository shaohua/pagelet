import { afterEach, describe, expect, it } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleRedirectUri,
  normalizeGoogleProfile,
  normalizeReturnTo
} from "./google-oauth";

const savedGoogleClientId = process.env.GOOGLE_CLIENT_ID;
const savedGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

afterEach(() => {
  restoreEnv("GOOGLE_CLIENT_ID", savedGoogleClientId);
  restoreEnv("GOOGLE_CLIENT_SECRET", savedGoogleClientSecret);
});

describe("google oauth helpers", () => {
  it("builds the Google authorization URL", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    const url = new URL(
      buildGoogleAuthorizationUrl({
        appBaseUrl: "https://pagelet.test",
        state: "signed-state"
      })
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://pagelet.test/auth/google/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("signed-state");
  });

  it("normalizes return paths without allowing open redirects", () => {
    expect(normalizeReturnTo("/cli-login/ABCD", "https://pagelet.test")).toBe(
      "/cli-login/ABCD"
    );
    expect(
      normalizeReturnTo("https://pagelet.test/p/pl_demo", "https://pagelet.test")
    ).toBe("/p/pl_demo");
    expect(
      normalizeReturnTo("https://outside.test/p/pl_demo", "https://pagelet.test")
    ).toBe("/");
    expect(normalizeReturnTo("//outside.test", "https://pagelet.test")).toBe("/");
  });

  it("exchanges an authorization code for an access token", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    const seen: { requestBody?: URLSearchParams } = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.requestBody = init?.body as URLSearchParams;
      return Response.json({ access_token: "access-token" });
    }) as typeof fetch;

    await expect(
      exchangeGoogleCode("oauth-code", "https://pagelet.test", fetchImpl)
    ).resolves.toBe("access-token");
    const body = seen.requestBody;

    if (!body) {
      throw new Error("Expected Google token request body");
    }
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("code")).toBe("oauth-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(
      "https://pagelet.test/auth/google/callback"
    );
  });

  it("normalizes verified Google profiles", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer access-token" });
      return Response.json({
        email: "REVIEWER@EXAMPLE.COM",
        email_verified: true,
        name: "Reviewer",
        picture: "https://lh3.googleusercontent.com/avatar"
      });
    }) as typeof fetch;

    await expect(fetchGoogleProfile("access-token", fetchImpl)).resolves.toEqual({
      email: "reviewer@example.com",
      name: "Reviewer",
      avatarUrl: "https://lh3.googleusercontent.com/avatar"
    });
  });

  it("rejects unverified Google email addresses", () => {
    expect(() =>
      normalizeGoogleProfile({
        email: "reviewer@example.com",
        email_verified: false
      })
    ).toThrow(Response);
  });

  it("builds the configured redirect URI", () => {
    expect(googleRedirectUri("https://pagelet.test/some/path")).toBe(
      "https://pagelet.test/auth/google/callback"
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
