import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoUser } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedEmailDomain,
  assertDevAuthProductionGuard,
  requireCliAuth,
  requirePageletAccess
} from "./auth";
import { createSessionCookie, createSessionPayload } from "./session";

const savedEnv = {
  ALLOWED_EMAIL_DOMAINS: process.env.ALLOWED_EMAIL_DOMAINS,
  NODE_ENV: process.env.NODE_ENV,
  PAGELET_DEPLOY_AUTH_MODE: process.env.PAGELET_DEPLOY_AUTH_MODE,
  PAGELET_DEV_AUTH: process.env.PAGELET_DEV_AUTH,
  PAGELET_DEV_TOKEN: process.env.PAGELET_DEV_TOKEN,
  PAGELET_REPOSITORY_BACKEND: process.env.PAGELET_REPOSITORY_BACKEND,
  PAGELET_STORAGE_DIR: process.env.PAGELET_STORAGE_DIR,
  SESSION_SECRET: process.env.SESSION_SECRET
};
const storageDirs: string[] = [];

afterEach(async () => {
  restoreEnv("ALLOWED_EMAIL_DOMAINS", savedEnv.ALLOWED_EMAIL_DOMAINS);
  restoreEnv("NODE_ENV", savedEnv.NODE_ENV);
  restoreEnv("PAGELET_DEPLOY_AUTH_MODE", savedEnv.PAGELET_DEPLOY_AUTH_MODE);
  restoreEnv("PAGELET_DEV_AUTH", savedEnv.PAGELET_DEV_AUTH);
  restoreEnv("PAGELET_DEV_TOKEN", savedEnv.PAGELET_DEV_TOKEN);
  restoreEnv("PAGELET_REPOSITORY_BACKEND", savedEnv.PAGELET_REPOSITORY_BACKEND);
  restoreEnv("PAGELET_STORAGE_DIR", savedEnv.PAGELET_STORAGE_DIR);
  restoreEnv("SESSION_SECRET", savedEnv.SESSION_SECRET);

  await Promise.all(
    storageDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
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

  it("allows dev web access for local reader routes", async () => {
    process.env.NODE_ENV = "development";
    const session = await requirePageletAccess(
      new Request("http://pagelet.test/p/pl_123")
    );

    expect(session.method).toBe("dev_web");
  });

  it("allows signed web sessions for reader routes", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAGELET_DEV_AUTH = "0";
    process.env.SESSION_SECRET = "test-session-secret";
    delete process.env.PAGELET_REPOSITORY_BACKEND;
    await useTempStorage();
    const cookie = createSessionCookie(
      createSessionPayload({
        userId: demoUser.id,
        orgId: demoUser.orgId,
        email: demoUser.email
      })
    ).split(";")[0] ?? "";
    const session = await requirePageletAccess(
      new Request("http://pagelet.test/p/pl_123", {
        headers: { Cookie: cookie }
      })
    );

    expect(session.method).toBe("web_session");
    expect(session.user.email).toBe(demoUser.email);
  });

  it("rejects wrong-domain users", async () => {
    await expectResponseStatus(
      () =>
        assertAllowedEmailDomain(
          {
            ...demoUser,
            email: "reviewer@outside.test"
          },
          ["example.com"]
        ),
      403
    );
  });

  it("rejects explicit dev auth in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PAGELET_DEV_AUTH = "1";
    delete process.env.PAGELET_DEPLOY_AUTH_MODE;

    expect(() => assertDevAuthProductionGuard()).toThrow(
      "PAGELET_DEV_AUTH=1 is not allowed"
    );
  });

  it("allows explicit dev auth in dev-preview deploys", () => {
    process.env.NODE_ENV = "production";
    process.env.PAGELET_DEV_AUTH = "1";
    process.env.PAGELET_DEPLOY_AUTH_MODE = "dev-preview";

    expect(() => assertDevAuthProductionGuard()).not.toThrow();
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
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function useTempStorage(): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "pagelet-auth-"));
  storageDirs.push(storageDir);
  process.env.PAGELET_STORAGE_DIR = storageDir;
}
