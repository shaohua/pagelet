import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdmin } from "./index.js";
import { createFakeAdmin, runServiceJson, type GcloudRoute } from "./testing.js";

const VIEWER_URL = "https://pagelet-123456.us-central1.run.app";
const CREATOR_URL = "https://pagelet-creator-123456.us-central1.run.app";

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
    when: "run services describe pagelet-creator",
    reply: {
      stdout: runServiceJson({
        url: CREATOR_URL,
        image:
          "us-central1-docker.pkg.dev/demo-project/pagelet-upstream/shaohua/pagelet:0.2.0",
        env: { PAGELET_SURFACE: "creator" }
      })
    }
  },
  {
    when: "run services describe pagelet --project",
    reply: {
      stdout: runServiceJson({
        url: VIEWER_URL,
        image:
          "us-central1-docker.pkg.dev/demo-project/pagelet-upstream/shaohua/pagelet:0.2.0",
        env: {
          PAGELET_SURFACE: "viewer",
          ALLOWED_EMAIL_DOMAINS: "example.com",
          GCS_BUCKET: "demo-project-pagelet"
        }
      })
    }
  }
];

const HEALTHY = [
  { when: `${VIEWER_URL}/health`, status: 403 },
  { when: `${CREATOR_URL}/health`, status: 200 },
  { when: "/api/publish-config", status: 401 },
  { when: "/r/not-public/1", status: 404 }
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
    if (originalConfig === undefined) delete process.env.PAGELET_CONFIG;
    else process.env.PAGELET_CONFIG = originalConfig;
  });

  it("reports both surfaces and their protection", async () => {
    const fake = createFakeAdmin({ gcloud: DEPLOYED, fetch: HEALTHY });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);
    const output = fake.io.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain(VIEWER_URL);
    expect(output).toContain(CREATOR_URL);
    expect(output).toContain("0.2.0");
    expect(output).toContain("Same image:");
    expect(output).toContain("Same image:       yes");
    expect(output).toContain("IAP viewer + Pagelet creator tokens");
    expect(output).toContain("example.com");
    expect(output).toContain("gs://demo-project-pagelet");
    expect(output).toContain("403 (protected)");
    expect(output).toContain("401 (refused)");
    expect(output).toContain("404 (absent)");
  });

  it("recognises a creator login on this machine", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ apiBaseUrl: CREATOR_URL, token: "cli-token" })
    );
    const fake = createFakeAdmin({ gcloud: DEPLOYED, fetch: HEALTHY });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("logged in");
  });

  it("points at setup when neither service is deployed", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("pagelet admin setup");
  });

  it("makes unsafe live responses visible", async () => {
    const fake = createFakeAdmin({
      gcloud: DEPLOYED,
      fetch: [
        { when: `${VIEWER_URL}/health`, status: 200 },
        { when: `${CREATOR_URL}/health`, status: 200 },
        { when: "/api/publish-config", status: 200 },
        { when: "/r/not-public/1", status: 200 }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("WARNING: not protected");
    expect(fake.io.lines.join("\n")).toContain("WARNING: not refused");
    expect(fake.io.lines.join("\n")).toContain("WARNING: exposed");
  });

  it("reports an expired gcloud login before checking services", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "projects describe",
          reply: {
            code: 1,
            stderr: "ERROR: Reauthentication failed while refreshing auth tokens"
          }
        }
      ]
    });
    const result = await runAdmin(["status", "--project", "demo-project"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("gcloud auth login");
  });
});
