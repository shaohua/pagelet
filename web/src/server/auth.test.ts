import { demoUser } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedEmailDomain,
  assertDevAuthProductionGuard,
  requireCliAuth,
  requirePageletAccess
} from "./auth";

const savedEnv = {
  ALLOWED_EMAIL_DOMAINS: process.env.ALLOWED_EMAIL_DOMAINS,
  NODE_ENV: process.env.NODE_ENV,
  PAGELET_DEPLOY_AUTH_MODE: process.env.PAGELET_DEPLOY_AUTH_MODE,
  PAGELET_DEV_AUTH: process.env.PAGELET_DEV_AUTH,
  PAGELET_DEV_TOKEN: process.env.PAGELET_DEV_TOKEN,
  PAGELET_IAP_AUDIENCE: process.env.PAGELET_IAP_AUDIENCE,
  PAGELET_SURFACE: process.env.PAGELET_SURFACE
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    restoreEnv(key, value);
  }
});

describe("auth helpers", () => {
  it("accepts the configured dev CLI bearer token", async () => {
    process.env.NODE_ENV = "development";
    process.env.PAGELET_DEV_TOKEN = "expected-token";
    const session = await requireCliAuth(
      new Request("http://pagelet.test/api/pagelets", {
        headers: { Authorization: "Bearer expected-token" }
      })
    );

    expect(session.method).toBe("dev_cli_token");
    expect(session.user.email).toBe(demoUser.email);
  });

  it("rejects missing or wrong CLI bearer tokens", async () => {
    process.env.NODE_ENV = "development";
    process.env.PAGELET_DEV_TOKEN = "expected-token";

    await expectResponseStatus(
      () => requireCliAuth(new Request("http://pagelet.test/api/pagelets")),
      401
    );
    await expectResponseStatus(
      () =>
        requireCliAuth(
          new Request("http://pagelet.test/api/pagelets", {
            headers: { Authorization: "Bearer wrong-token" }
          })
        ),
      401
    );
  });

  it("allows dev web access for local viewer routes", async () => {
    process.env.NODE_ENV = "development";
    const session = await requirePageletAccess(
      new Request("http://pagelet.test/p/pl_123")
    );

    expect(session.method).toBe("dev_web");
  });

  it("requires an IAP assertion in production viewer mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAGELET_DEV_AUTH = "0";
    process.env.PAGELET_DEPLOY_AUTH_MODE = "iap";
    process.env.PAGELET_IAP_AUDIENCE =
      "/projects/123/locations/us-central1/services/pagelet";
    delete process.env.PAGELET_SURFACE;

    await expectResponseStatus(
      () =>
        requirePageletAccess(
          new Request("https://pagelet.test/api/pagelets/example", {
            headers: { Authorization: "Bearer cannot-bypass-iap" }
          })
        ),
      401
    );
  });

  it("rejects wrong-domain users", async () => {
    await expectResponseStatus(
      () =>
        assertAllowedEmailDomain(
          { ...demoUser, email: "reviewer@outside.test" },
          ["example.com"]
        ),
      403
    );
  });

  it("rejects explicit dev auth in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PAGELET_DEV_AUTH = "1";

    expect(() => assertDevAuthProductionGuard()).toThrow(
      "PAGELET_DEV_AUTH=1 is not allowed"
    );
  });
});

async function expectResponseStatus(
  action: () => unknown | Promise<unknown>,
  status: number
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected Response ${status}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(status);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
