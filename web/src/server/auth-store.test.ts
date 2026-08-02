import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoOrganization, demoUser } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmCliLogin,
  hashSecret,
  pollCliLogin,
  startCliLogin,
  verifyCliToken
} from "./auth-store";

const savedStorageDir = process.env.PAGELET_STORAGE_DIR;
const savedAllowedDomains = process.env.ALLOWED_EMAIL_DOMAINS;
const storageDirs: string[] = [];

afterEach(async () => {
  if (savedStorageDir === undefined) {
    delete process.env.PAGELET_STORAGE_DIR;
  } else {
    process.env.PAGELET_STORAGE_DIR = savedStorageDir;
  }

  if (savedAllowedDomains === undefined) {
    delete process.env.ALLOWED_EMAIL_DOMAINS;
  } else {
    process.env.ALLOWED_EMAIL_DOMAINS = savedAllowedDomains;
  }

  await Promise.all(
    storageDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("auth store", () => {
  it("starts, confirms, polls, and consumes a CLI login", async () => {
    await useTempStorage();
    const started = await startCliLogin(
      { label: "Laptop" },
      "http://127.0.0.1:3000"
    );

    expect(started.verificationUrl).toBe(
      `http://127.0.0.1:3000/cli-login/${started.userCode}`
    );
    await expect(pollCliLogin({ userCode: started.userCode })).resolves.toEqual({
      status: "pending"
    });

    await confirmCliLogin(started.userCode, {
      user: demoUser,
      organization: demoOrganization
    });
    const completed = await pollCliLogin({ userCode: started.userCode });

    expect(completed.status).toBe("complete");

    if (completed.status !== "complete") {
      throw new Error("Expected completed login");
    }

    expect(completed.user).toEqual(demoUser);
    expect(completed.organization).toEqual(demoOrganization);
    await expect(verifyCliToken(completed.token)).resolves.toEqual({
      user: demoUser,
      organization: demoOrganization
    });
    await expect(pollCliLogin({ userCode: started.userCode })).resolves.toEqual({
      status: "expired"
    });
  });

  it("issues CLI tokens for the approving identity", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "example.com";
    await useTempStorage();
    const started = await startCliLogin(
      { label: "Workstation" },
      "http://127.0.0.1:3000"
    );
    const identity = {
      organization: {
        ...demoOrganization,
        id: "11111111-1111-4111-8111-111111111112"
      },
      user: {
        ...demoUser,
        id: "22222222-2222-4222-8222-222222222223",
        orgId: "11111111-1111-4111-8111-111111111112",
        email: "reviewer@example.com",
        name: "Reviewer"
      }
    };

    await confirmCliLogin(started.userCode, identity);
    const completed = await pollCliLogin({ userCode: started.userCode });

    expect(completed.status).toBe("complete");

    if (completed.status !== "complete") {
      throw new Error("Expected completed login");
    }

    expect(completed.user).toEqual(identity.user);
    expect(completed.organization).toEqual(identity.organization);
    await expect(verifyCliToken(completed.token)).resolves.toEqual(identity);
  });

  it("hashes secrets without returning the raw value", () => {
    expect(hashSecret("secret-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret("secret-token")).not.toBe("secret-token");
  });
});

async function useTempStorage(): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "pagelet-auth-store-"));
  storageDirs.push(storageDir);
  process.env.PAGELET_STORAGE_DIR = storageDir;
}
