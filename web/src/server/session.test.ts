import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionCookie,
  createSessionPayload,
  readSessionPayload,
  signPayload
} from "./session";

const savedSessionSecret = process.env.SESSION_SECRET;

afterEach(() => {
  vi.useRealTimers();

  if (savedSessionSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = savedSessionSecret;
  }
});

describe("session cookies", () => {
  it("signs and reads a session payload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    process.env.SESSION_SECRET = "test-session-secret";
    const payload = createSessionPayload({
      userId: "22222222-2222-4222-8222-222222222222",
      orgId: "11111111-1111-4111-8111-111111111111",
      email: "reviewer@example.com",
      now: new Date("2026-06-21T12:00:00.000Z")
    });
    const cookie = createSessionCookie(payload).split(";")[0] ?? "";

    expect(
      readSessionPayload(
        new Request("http://pagelet.test", {
          headers: {
            Cookie: cookie
          }
        })
      )
    ).toEqual(payload);
  });

  it("rejects tampered session cookies", () => {
    process.env.SESSION_SECRET = "test-session-secret";
    const payload = createSessionPayload({
      userId: "22222222-2222-4222-8222-222222222222",
      orgId: "11111111-1111-4111-8111-111111111111",
      email: "reviewer@example.com"
    });
    const cookie = createSessionCookie(payload).split(";")[0] ?? "";
    const tamperedCookie = `${cookie.slice(0, -1)}${
      cookie.endsWith("x") ? "y" : "x"
    }`;

    expect(
      readSessionPayload(
        new Request("http://pagelet.test", {
          headers: {
            Cookie: tamperedCookie
          }
        })
      )
    ).toBeNull();
  });

  it("rejects expired session payloads", () => {
    process.env.SESSION_SECRET = "test-session-secret";
    const signedPayload = signPayload({
      userId: "22222222-2222-4222-8222-222222222222",
      orgId: "11111111-1111-4111-8111-111111111111",
      email: "reviewer@example.com",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });

    expect(
      readSessionPayload(
        new Request("http://pagelet.test", {
          headers: {
            Cookie: `pagelet_session=${signedPayload}`
          }
        })
      )
    ).toBeNull();
  });
});
