import { describe, expect, it } from "vitest";
import { runAdmin } from "./index.js";
import { buildDeployArgs, parseSetupArgs, resolveDomains } from "./setup.js";
import {
  createFakeAdmin,
  flagValue,
  runServiceJson,
  type GcloudRoute
} from "./testing.js";

const PROJECT = "demo-project";
const PROJECT_NUMBER = "123456";
const VIEWER_URL = `https://pagelet-${PROJECT_NUMBER}.us-central1.run.app`;
const CREATOR_URL = `https://pagelet-creator-${PROJECT_NUMBER}.us-central1.run.app`;
const BASE_ARGS = ["setup", "--project", PROJECT];

const PREFLIGHT: GcloudRoute[] = [
  { when: "--version", reply: { stdout: "Google Cloud SDK 500.0.0" } },
  {
    when: "auth list",
    reply: {
      stdout: JSON.stringify([{ account: "admin@example.com", status: "ACTIVE" }])
    }
  },
  {
    when: "projects describe",
    reply: {
      stdout: JSON.stringify({ projectNumber: PROJECT_NUMBER, lifecycleState: "ACTIVE" })
    }
  },
  {
    when: "billing projects describe",
    reply: { stdout: JSON.stringify({ billingEnabled: true }) }
  },
  {
    when: "projects get-ancestors",
    reply: {
      stdout: JSON.stringify([
        { id: PROJECT, type: "project" },
        { id: "654321", type: "organization" }
      ])
    }
  }
];

const DEPLOY_ROUTES: GcloudRoute[] = [
  ...PREFLIGHT,
  {
    when: "run services describe pagelet-creator",
    replies: [
      { stdout: "" },
      {
        stdout: runServiceJson({
          url: CREATOR_URL,
          env: { PAGELET_SURFACE: "creator" }
        })
      }
    ]
  },
  {
    when: "run services describe pagelet --project",
    replies: [
      { stdout: "" },
      {
        stdout: runServiceJson({
          url: VIEWER_URL,
          env: { PAGELET_SURFACE: "viewer" }
        })
      }
    ]
  }
];

describe("pagelet admin setup", () => {
  it("prints a two-service plan without mutating anything in dry-run mode", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT });
    const result = await runAdmin([...BASE_ARGS, "--dry-run"], fake.deps);
    const output = fake.io.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("IAP viewer service pagelet");
    expect(output).toContain("creator API service pagelet-creator");
    expect(output).toContain("work domains      example.com");
    expect(output).toContain("nothing was created or changed");
    expect(fake.gcloud.mutations()).toEqual([]);
    expect(fake.io.prompts).toEqual([]);
  });

  it("deploys one image as an IAP viewer and a token-protected creator API", async () => {
    const fake = createFakeAdmin({
      gcloud: DEPLOY_ROUTES,
      fetch: [
        { when: `${VIEWER_URL}/health`, status: 403 },
        { when: `${CREATOR_URL}/health`, status: 200 },
        { when: "/api/publish-config", status: 401 },
        { when: "/r/not-public/1", status: 404 }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--yes"], fake.deps);
    const deploys = fake.gcloud.calls.filter(
      ({ args }) => args[0] === "run" && args[1] === "deploy"
    );

    expect(result.exitCode).toBe(0);
    expect(deploys).toHaveLength(2);

    const viewer = deploys.find(({ args }) => args[2] === "pagelet");
    const creator = deploys.find(({ args }) => args[2] === "pagelet-creator");
    expect(viewer?.args).toContain("--iap");
    expect(viewer?.args).toContain("--invoker-iam-check");
    expect(viewer?.args).toContain("--no-allow-unauthenticated");
    expect(flagValue(viewer!, "--set-env-vars")).toContain("PAGELET_SURFACE=viewer");
    expect(flagValue(viewer!, "--set-env-vars")).toContain(
      `PAGELET_IAP_AUDIENCE=/projects/${PROJECT_NUMBER}/locations/us-central1/services/pagelet`
    );
    expect(creator?.args).toContain("--no-iap");
    expect(creator?.args).toContain("--no-invoker-iam-check");
    expect(flagValue(creator!, "--set-env-vars")).toContain("PAGELET_SURFACE=creator");
    expect(flagValue(creator!, "--set-env-vars")).toContain(`APP_BASE_URL=${VIEWER_URL}`);

    const commands = fake.gcloud.calls.map(({ args }) => args.join(" ")).join("\n");
    expect(commands).toContain("roles/iap.httpsResourceAccessor");
    expect(commands).toContain("--member domain:example.com");
    expect(commands).toContain(
      `serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com`
    );
    expect(commands).not.toContain("allUsers");
    expect(deploys.some(({ args }) => args.includes("--allow-unauthenticated"))).toBe(false);
    expect(commands).not.toContain("secrets versions");
    expect(fake.logins).toEqual([CREATOR_URL]);
    expect(fake.io.lines.join("\n")).toContain(`Viewer:  ${VIEWER_URL}`);
    expect(fake.io.lines.join("\n")).toContain(`Creator: ${CREATOR_URL}`);
  });

  it("builds source once and reuses that image for the creator service", async () => {
    const fake = createFakeAdmin({ gcloud: DEPLOY_ROUTES });
    const result = await runAdmin(
      [...BASE_ARGS, "--source", ".", "--yes"],
      fake.deps
    );
    const deploys = fake.gcloud.calls.filter(
      ({ args }) => args[0] === "run" && args[1] === "deploy"
    );
    const commands = fake.gcloud.calls.map(({ args }) => args.join(" ")).join("\n");

    expect(result.exitCode).toBe(0);
    expect(deploys).toHaveLength(2);
    expect(flagValue(deploys[0]!, "--source")).toBe(".");
    expect(flagValue(deploys[1]!, "--source")).toBe("");
    expect(flagValue(deploys[1]!, "--image")).toContain("pagelet:0.1.0");
    expect(commands).toContain("cloudbuild.googleapis.com");
    expect(commands).not.toContain("artifacts repositories create");
    expect(fake.io.lines.join("\n")).toContain("reusing the viewer build");
  });

  it("retries a viewer deploy while newly enabled APIs propagate", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...DEPLOY_ROUTES,
        {
          when: "run deploy pagelet --project",
          replies: [
            { code: 1, stderr: "SERVICE_DISABLED: API enablement is propagating" },
            { code: 0 }
          ]
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--yes"], fake.deps);
    const viewerDeploys = fake.gcloud.calls.filter(({ args }) =>
      args.join(" ").includes("run deploy pagelet --project")
    );

    expect(result.exitCode).toBe(0);
    expect(viewerDeploys).toHaveLength(2);
    expect(fake.io.lines.join("\n")).toContain("retrying in 20s");
  });

  it("refuses an unmanaged service before changing the project", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe pagelet-creator",
          reply: { stdout: runServiceJson({ url: CREATOR_URL, managed: false }) }
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--yes"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("was not created by pagelet admin");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("requires --yes when setup cannot ask for confirmation", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT, interactive: false });
    const result = await runAdmin(BASE_ARGS, fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("Re-run with --yes");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("requires an organization so IAP needs no manual OAuth client", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        { when: "projects get-ancestors", reply: { stdout: "[]" } }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--yes"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("not attached");
    expect(fake.io.errors.join("\n")).toContain("automatic IAP setup");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("rejects public account domains instead of granting all consumers access", () => {
    expect(() => resolveDomains(undefined, "admin@gmail.com")).toThrow(
      "public email domain"
    );
    expect(() => resolveDomains("gmail.com", "admin@example.com")).toThrow(
      "public email domain"
    );
    expect(resolveDomains("Admin@Example.com,@SECOND.test", "admin@example.com")).toEqual([
      "example.com",
      "second.test"
    ]);
  });

  it("has no OAuth or public-preview setup options", () => {
    expect(() => parseSetupArgs(["--auth", "google"])).toThrow("Unknown");
    expect(() => parseSetupArgs(["--google-client-id", "id"])).toThrow("Unknown");
    expect(() => parseSetupArgs(["--domain", "http://pagelet.test"])).toThrow(
      "must use https"
    );
  });
});

describe("Cloud Run deploy arguments", () => {
  const base = {
    project: PROJECT,
    projectNumber: PROJECT_NUMBER,
    region: "us-central1",
    service: "pagelet",
    serviceAccount: "pagelet-run@demo-project.iam.gserviceaccount.com",
    viewerUrl: VIEWER_URL,
    domains: ["example.com"],
    bucket: "demo-project-pagelet",
    image: "example.test/pagelet:1.0.0"
  } as const;

  it("never emits a public viewer or an IAP creator", () => {
    const viewer = buildDeployArgs({ ...base, surface: "viewer" }).join(" ");
    const creator = buildDeployArgs({
      ...base,
      service: "pagelet-creator",
      surface: "creator"
    }).join(" ");

    expect(viewer).toContain("--iap");
    expect(viewer).toContain("--no-allow-unauthenticated");
    expect(viewer).not.toContain("--no-invoker-iam-check");
    expect(creator).toContain("--no-iap");
    expect(creator).toContain("--no-invoker-iam-check");
    expect(buildDeployArgs({ ...base, surface: "viewer" })).not.toContain(
      "--allow-unauthenticated"
    );
  });
});
