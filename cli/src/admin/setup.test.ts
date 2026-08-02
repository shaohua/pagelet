import { describe, expect, it } from "vitest";
import { cliVersion } from "../version.js";
import { createGcloudRunner, isGcloudMissingError } from "./gcloud.js";
import { runAdmin } from "./index.js";
import { buildDeployArgs, resolveDomains } from "./setup.js";
import {
  createFakeAdmin,
  flagValue,
  managedLabels,
  runServiceJson,
  type FetchRoute,
  type GcloudRoute
} from "./testing.js";

const PREDICTED_URL = "https://pagelet-123456.us-central1.run.app";

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
  },
  {
    when: "billing projects describe",
    reply: { stdout: JSON.stringify({ billingEnabled: true }) }
  }
];

const HEALTHY: FetchRoute[] = [
  { when: "run.app", status: 200 },
  { when: "/api/publish-config", status: 401 },
  {
    when: "/auth/google",
    status: 302,
    headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" }
  }
];

const BASE_ARGS = ["setup", "--project", "demo-project"];

describe("pagelet admin setup preflight", () => {
  it("explains how to install a missing gcloud", async () => {
    const fake = createFakeAdmin();
    const result = await runAdmin(BASE_ARGS, {
      ...fake.deps,
      gcloud: createGcloudRunner("pagelet-gcloud-does-not-exist")
    });

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain(
      "https://cloud.google.com/sdk/docs/install"
    );
  });

  it("surfaces ENOENT as a distinguishable missing-gcloud error", async () => {
    const runner = createGcloudRunner("pagelet-gcloud-does-not-exist");
    const error = await runner(["--version"]).catch((cause: unknown) => cause);

    expect(isGcloudMissingError(error)).toBe(true);
  });

  it("asks for a login when no account is active", async () => {
    const fake = createFakeAdmin({
      gcloud: [...PREFLIGHT, { when: "auth list", reply: { stdout: "[]" } }]
    });
    const result = await runAdmin(BASE_ARGS, fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("gcloud auth login");
  });

  it("asks for a project when gcloud has none configured", async () => {
    const fake = createFakeAdmin({
      gcloud: [...PREFLIGHT, { when: "config list", reply: { stdout: "{}" } }]
    });
    const result = await runAdmin(["setup"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("--project");
  });

  it("refuses to reviewer-list a public email domain", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "auth list",
          reply: {
            stdout: JSON.stringify([{ account: "dev@gmail.com", status: "ACTIVE" }])
          }
        }
      ]
    });
    const result = await runAdmin(BASE_ARGS, fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("--allow");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("refuses a service it does not manage", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          reply: { stdout: runServiceJson({ url: PREDICTED_URL, managed: false }) }
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("not created by pagelet admin");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("refuses to downgrade an instance deployed by a newer CLI", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          reply: {
            stdout: runServiceJson({
              url: PREDICTED_URL,
              image: "us-central1-docker.pkg.dev/p/pagelet-upstream/shaohua/pagelet:9.9.9"
            })
          }
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("newer than this CLI");
    expect(fake.io.errors.join("\n")).toContain("npm i -g @howtox/pagelet@latest");
    expect(fake.gcloud.mutations()).toEqual([]);
  });
});

describe("pagelet admin setup plan", () => {
  it("prints a plan and changes nothing on a dry run", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT });
    const result = await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--dry-run"],
      fake.deps
    );

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("Plan");
    expect(fake.io.lines.join("\n")).toContain("+ create  Cloud Run service pagelet");
    expect(fake.io.lines.join("\n")).toContain("Dry run");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("changes nothing when the confirmation is declined", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT, confirms: [false] });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.lines.join("\n")).toContain("Aborted");
    expect(fake.gcloud.mutations()).toEqual([]);
  });
});

describe("pagelet admin setup apply", () => {
  it("deploys the pinned image, wires the config, and logs in", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        }
      ],
      fetch: HEALTHY,
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const deploy = fake.gcloud.call("run deploy");
    expect(flagValue(deploy, "--image")).toBe(
      `us-central1-docker.pkg.dev/demo-project/pagelet-upstream/shaohua/pagelet:${cliVersion()}`
    );

    const env = flagValue(deploy, "--set-env-vars");
    expect(env).toContain(`APP_BASE_URL=${PREDICTED_URL}`);
    expect(env).toContain("ALLOWED_EMAIL_DOMAINS=example.com");
    expect(env).toContain("GCS_BUCKET=demo-project-pagelet");
    expect(env).toContain("GOOGLE_CLIENT_ID=client-id-123");
    expect(env).toContain("PAGELET_DEV_AUTH=0");

    const secrets = flagValue(deploy, "--set-secrets");
    expect(secrets).toContain("SESSION_SECRET=pagelet-session-secret:latest");
    expect(secrets).toContain("GOOGLE_CLIENT_SECRET=pagelet-google-client-secret:latest");

    // The OAuth secret reaches gcloud on stdin, never on the command line.
    const stored = fake.gcloud.call("secrets create pagelet-google-client-secret");
    expect(stored.stdin).toBe("client-secret-xyz");
    expect(stored.args.join(" ")).not.toContain("client-secret-xyz");

    expect(fake.io.prompts).toHaveLength(3);
    expect(fake.logins).toEqual([PREDICTED_URL]);
    expect(fake.io.lines.join("\n")).toContain("Logged in as dev@example.com");
  });

  it("converges an existing instance without asking for the OAuth client again", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          reply: {
            stdout: runServiceJson({
              url: PREDICTED_URL,
              image:
                "us-central1-docker.pkg.dev/demo-project/pagelet-upstream/shaohua/pagelet:0.1.0",
              env: { GOOGLE_CLIENT_ID: "existing-client-id" }
            })
          }
        },
        {
          when: "secrets describe pagelet-session-secret",
          reply: { stdout: managedLabels() }
        },
        {
          when: "secrets describe pagelet-google-client-secret",
          reply: { stdout: managedLabels() }
        }
      ],
      fetch: HEALTHY,
      confirms: [true]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.prompts).toEqual(["Continue?"]);
    expect(fake.io.lines.join("\n")).toContain("~ update  Cloud Run service pagelet");
    expect(flagValue(fake.gcloud.call("run deploy"), "--set-env-vars")).toContain(
      "GOOGLE_CLIENT_ID=existing-client-id"
    );
    // Rotating either secret would sign everyone out or break sign-in.
    expect(fake.gcloud.find("secrets create")).toBeUndefined();
    expect(fake.gcloud.find("secrets versions add")).toBeUndefined();
  });

  it("corrects APP_BASE_URL and the redirect URI when the URL is not the predicted one", async () => {
    const actualUrl = "https://pagelet-xyz123-uc.a.run.app";
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: actualUrl }) }]
        }
      ],
      fetch: [{ when: "a.run.app", status: 200 }, ...HEALTHY],
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);

    const update = fake.gcloud.call("run services update");
    expect(flagValue(update, "--update-env-vars")).toBe(`APP_BASE_URL=${actualUrl}`);
    expect(fake.io.lines.join("\n")).toContain(
      `${actualUrl}/auth/google/callback`
    );
    expect(fake.logins).toEqual([actualUrl]);
  });

  it("warns loudly when the instance answers the API without a token", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        }
      ],
      fetch: [...HEALTHY, { when: "/api/publish-config", status: 200 }],
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.errors.join("\n")).toContain("world-readable");
  });

  it("retries a deploy that raced newly enabled APIs", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        },
        {
          when: "run deploy",
          replies: [
            {
              code: 1,
              stderr: "Cloud Run Admin API has not been used in project 123456 before"
            },
            { code: 0 }
          ]
        }
      ],
      fetch: HEALTHY,
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("still propagating");
  });

  it("explains an organization policy that forbids public services", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run deploy",
          reply: {
            code: 1,
            stderr:
              "ERROR: One or more users named in the policy do not belong to a permitted customer: constraints/iam.allowedPolicyMemberDomains"
          }
        }
      ],
      fetch: HEALTHY,
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("organization policy");
  });

  it("keeps dev-preview behind an explicit warning and a second confirmation", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        }
      ],
      fetch: [...HEALTHY, { when: "/api/publish-config", status: 200 }],
      confirms: [true, false]
    });
    const result = await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--auth", "dev-preview"],
      fake.deps
    );

    expect(result.exitCode).toBe(1);
    expect(fake.io.lines.join("\n")).toContain(
      "anyone with the URL can read and comment on every report"
    );
    expect(fake.gcloud.find("run deploy")).toBeUndefined();
  });
});

describe("setup helpers", () => {
  it("defaults reviewer domains to the account domain", () => {
    expect(resolveDomains(undefined, "dev@example.com")).toEqual(["example.com"]);
    expect(resolveDomains("A.com, @b.com", "dev@gmail.com")).toEqual(["a.com", "b.com"]);
  });

  it("mounts the dev token instead of the OAuth secret in dev-preview", () => {
    const args = buildDeployArgs({
      project: "demo-project",
      region: "us-central1",
      service: "pagelet",
      serviceAccount: "pagelet-run@demo-project.iam.gserviceaccount.com",
      authMode: "dev-preview",
      baseUrl: PREDICTED_URL,
      domains: ["example.com"],
      bucket: "demo-project-pagelet",
      image: null,
      source: "."
    });

    expect(args).toContain("--source");
    expect(args).not.toContain("--image");
    expect(args.join(" ")).toContain("PAGELET_DEV_AUTH=1");
    expect(args.join(" ")).toContain("PAGELET_DEV_TOKEN=pagelet-dev-token:latest");
    expect(args.join(" ")).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("keeps commas inside values with the ^@^ delimiter", () => {
    const args = buildDeployArgs({
      project: "demo-project",
      region: "us-central1",
      service: "pagelet",
      serviceAccount: "pagelet-run@demo-project.iam.gserviceaccount.com",
      authMode: "google",
      baseUrl: PREDICTED_URL,
      domains: ["example.com", "partner.com"],
      bucket: "demo-project-pagelet",
      image: "ghcr.io/shaohua/pagelet:1.0.0",
      googleClientId: "client-id-123"
    });
    const env = args[args.indexOf("--set-env-vars") + 1] ?? "";

    expect(env.startsWith("^@^")).toBe(true);
    expect(env).toContain("ALLOWED_EMAIL_DOMAINS=example.com,partner.com");
  });

  it("admits the demo user's domain in dev-preview deploys", () => {
    const base = {
      project: "demo-project",
      region: "us-central1",
      service: "pagelet",
      serviceAccount: "pagelet-run@demo-project.iam.gserviceaccount.com",
      baseUrl: PREDICTED_URL,
      domains: ["corp.com"],
      bucket: "demo-project-pagelet",
      image: "ghcr.io/shaohua/pagelet:1.0.0"
    };
    const dev = buildDeployArgs({ ...base, authMode: "dev-preview" }).join(" ");
    const google = buildDeployArgs({
      ...base,
      authMode: "google",
      googleClientId: "client-id-123"
    }).join(" ");

    expect(dev).toContain("ALLOWED_EMAIL_DOMAINS=corp.com,example.com");
    expect(google).toContain("ALLOWED_EMAIL_DOMAINS=corp.com@");
  });

  it("keeps only the domain of a pasted email address", () => {
    expect(resolveDomains("user@example.com", "dev@corp.com")).toEqual(["example.com"]);
  });

  it("refuses an env value containing the list delimiter", () => {
    expect(() =>
      buildDeployArgs({
        project: "demo-project",
        region: "us-central1",
        service: "pagelet",
        serviceAccount: "pagelet-run@demo-project.iam.gserviceaccount.com",
        authMode: "google",
        baseUrl: PREDICTED_URL,
        domains: ["example.com"],
        bucket: "demo-project-pagelet",
        image: "ghcr.io/shaohua/pagelet:1.0.0",
        googleClientId: "client-id-123",
        allowedExternalOrigins: "https://user@cdn.example.com"
      })
    ).toThrow(/delimiter/);
  });
});

describe("pagelet admin setup guards", () => {
  it("rejects a --domain that is not an absolute https URL", async () => {
    const fake = createFakeAdmin();
    const result = await runAdmin([...BASE_ARGS, "--domain", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("https");
    expect(fake.gcloud.calls).toEqual([]);
  });

  it("dry-runs without a terminal and without OAuth flags", async () => {
    const fake = createFakeAdmin({ gcloud: PREFLIGHT, interactive: false });
    const result = await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--dry-run"],
      fake.deps
    );

    expect(result.exitCode).toBe(0);
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("converges non-interactively when the OAuth client is already deployed", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          reply: {
            stdout: runServiceJson({
              url: PREDICTED_URL,
              env: { GOOGLE_CLIENT_ID: "existing-client-id" }
            })
          }
        },
        {
          when: "secrets describe pagelet-session-secret",
          reply: { stdout: managedLabels() }
        },
        {
          when: "secrets describe pagelet-google-client-secret",
          reply: { stdout: managedLabels() }
        }
      ],
      fetch: HEALTHY,
      interactive: false
    });
    const result = await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--yes"],
      fake.deps
    );

    expect(result.exitCode).toBe(0);
    expect(fake.io.prompts).toEqual([]);
    expect(fake.logins).toEqual([]);
    expect(fake.io.lines.join("\n")).toContain("pagelet login");
  });

  it("fails loudly when an organization policy blocks public access", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        },
        {
          when: "run services get-iam-policy",
          reply: { stdout: JSON.stringify({ etag: "ACAB" }) }
        },
        {
          when: "run services add-iam-policy-binding",
          reply: {
            code: 1,
            stderr:
              "FAILED_PRECONDITION: One or more users named in the policy do not belong to a permitted customer."
          }
        }
      ],
      fetch: HEALTHY,
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);
    const errors = fake.io.errors.join("\n");

    expect(result.exitCode).toBe(1);
    expect(errors).toContain("allowedPolicyMemberDomains");
    expect(errors).toContain("re-run: pagelet admin setup");
    expect(fake.io.lines.join("\n")).not.toContain("Pagelet is ready");
  });

  it("reports public reachability when the invoker binding already exists", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          replies: [{}, { stdout: runServiceJson({ url: PREDICTED_URL }) }]
        },
        {
          when: "run services get-iam-policy",
          reply: {
            stdout: JSON.stringify({
              bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }]
            })
          }
        }
      ],
      fetch: HEALTHY,
      confirms: [true],
      answers: ["client-id-123", "client-secret-xyz"]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("public at the platform edge");
    expect(fake.gcloud.find("run services add-iam-policy-binding")).toBeUndefined();
  });

  it("grants Cloud Build the builder role only when deploying from source", async () => {
    const source = createFakeAdmin({ gcloud: PREFLIGHT, interactive: false });
    const sourceResult = await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--auth", "dev-preview", "--source", ".", "--yes"],
      source.deps
    );

    expect(sourceResult.exitCode).toBe(0);
    const binding = source.gcloud.call("projects add-iam-policy-binding");
    expect(binding.args.join(" ")).toContain(
      "serviceAccount:123456-compute@developer.gserviceaccount.com"
    );
    expect(binding.args.join(" ")).toContain("roles/cloudbuild.builds.builder");

    const image = createFakeAdmin({ gcloud: PREFLIGHT, interactive: false });
    await runAdmin(
      [...BASE_ARGS, "--allow", "example.com", "--auth", "dev-preview", "--yes"],
      image.deps
    );

    expect(image.gcloud.find("projects add-iam-policy-binding")).toBeUndefined();
  });

  it("refuses a session secret it does not manage", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "secrets describe pagelet-session-secret",
          reply: { stdout: JSON.stringify({ labels: {} }) }
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("not created by pagelet admin");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("refuses a service account it does not manage", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "service-accounts describe",
          reply: {
            stdout: JSON.stringify({
              email: "pagelet-run@demo-project.iam.gserviceaccount.com",
              description: "Someone else's account"
            })
          }
        }
      ]
    });
    const result = await runAdmin([...BASE_ARGS, "--allow", "example.com"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("not created by pagelet admin");
    expect(fake.gcloud.mutations()).toEqual([]);
  });
});
