import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdmin } from "./index.js";
import { createFakeAdmin, runServiceJson, type GcloudRoute } from "./testing.js";

const LIVE_URL = "https://pagelet-123456.us-central1.run.app";

const PREFLIGHT: GcloudRoute[] = [
  { when: "--version", reply: { stdout: "Google Cloud SDK 500.0.0" } },
  {
    when: "auth list",
    reply: {
      stdout: JSON.stringify([{ account: "dev@example.com", status: "ACTIVE" }])
    }
  },
  {
    when: "projects describe",
    reply: {
      stdout: JSON.stringify({ projectNumber: "123456", lifecycleState: "ACTIVE" })
    }
  }
];

const DEPLOYED: GcloudRoute[] = [
  ...PREFLIGHT,
  {
    when: "run services describe",
    reply: {
      stdout: runServiceJson({
        url: LIVE_URL,
        image:
          "us-central1-docker.pkg.dev/demo-project/pagelet-upstream/shaohua/pagelet:0.1.1",
        env: {
          PAGELET_DEPLOY_AUTH_MODE: "google",
          ALLOWED_EMAIL_DOMAINS: "example.com",
          GCS_BUCKET: "demo-project-pagelet"
        }
      })
    }
  }
];

describe("pagelet admin status", () => {
  const originalConfig = process.env.PAGELET_CONFIG;
  let configPath = "";

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), "pagelet-admin-status-"));
    configPath = join(directory, "config.json");
    process.env.PAGELET_CONFIG = configPath;
  });

  afterEach(() => {
    if (originalConfig === undefined) {
      delete process.env.PAGELET_CONFIG;
      return;
    }

    process.env.PAGELET_CONFIG = originalConfig;
  });

  it("reports the deployed instance", async () => {
    const fake = createFakeAdmin({
      gcloud: DEPLOYED,
      fetch: [
        { when: "run.app", status: 200 },
        { when: "/api/publish-config", status: 401 }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);
    const output = fake.io.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain(LIVE_URL);
    expect(output).toContain("0.1.1");
    expect(output).toContain("google");
    expect(output).toContain("example.com");
    expect(output).toContain("gs://demo-project-pagelet");
    expect(output).toContain("401 (refused)");
    expect(output).toContain("not logged in");
    expect(fake.io.errors).toEqual([]);
  });

  it("recognises a machine that is logged in to this instance", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ apiBaseUrl: LIVE_URL, token: "cli-token" })
    );

    const fake = createFakeAdmin({
      gcloud: DEPLOYED,
      fetch: [
        { when: "run.app", status: 200 },
        { when: "/api/publish-config", status: 401 }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("logged in");
  });

  it("points at setup when nothing is deployed", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("pagelet admin setup");
  });

  it("reports an expired gcloud login instead of pretending nothing is deployed", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "projects describe",
          reply: {
            code: 1,
            stderr:
              "ERROR: There was a problem refreshing your current auth tokens: Reauthentication failed."
          }
        }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);
    const errors = fake.io.errors.join("\n");

    expect(result.exitCode).toBe(1);
    expect(errors).toContain("gcloud auth login");
    expect(errors).not.toContain("not deployed");
  });

  it("warns when the API answers without a token", async () => {
    const fake = createFakeAdmin({
      gcloud: DEPLOYED,
      fetch: [
        { when: "run.app", status: 200 },
        { when: "/api/publish-config", status: 200 }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.errors.join("\n")).toContain(
      "anyone with the URL can read and comment"
    );
  });
});
