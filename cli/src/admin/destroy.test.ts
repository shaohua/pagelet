import { describe, expect, it } from "vitest";
import { runAdmin } from "./index.js";
import {
  createFakeAdmin,
  managedLabels,
  runServiceJson,
  type GcloudRoute
} from "./testing.js";

const LIVE_URL = "https://pagelet-123456.us-central1.run.app";
const BUCKET = "demo-project-pagelet";

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

const MANAGED: GcloudRoute[] = [
  ...PREFLIGHT,
  {
    when: "run services describe",
    reply: {
      stdout: runServiceJson({ url: LIVE_URL, env: { GCS_BUCKET: BUCKET } })
    }
  },
  { when: "secrets describe pagelet-session-secret", reply: { stdout: managedLabels() } },
  { when: "storage buckets describe", reply: { stdout: managedLabels() } },
  { when: "artifacts repositories describe", reply: { stdout: managedLabels() } },
  {
    when: "service-accounts describe",
    reply: {
      stdout: JSON.stringify({
        email: "pagelet-run@demo-project.iam.gserviceaccount.com",
        description: "Managed by pagelet admin"
      })
    }
  }
];

const BASE_ARGS = ["destroy", "--project", "demo-project"];

describe("pagelet admin destroy", () => {
  it("keeps the reports bucket unless asked to delete it", async () => {
    const fake = createFakeAdmin({ gcloud: MANAGED, confirms: [true] });
    const result = await runAdmin(BASE_ARGS, fake.deps);
    const output = fake.io.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain(`keep    bucket gs://${BUCKET}`);
    expect(output).toContain("--delete-data");
    expect(fake.gcloud.find("storage rm")).toBeUndefined();
    expect(
      fake.gcloud.calls.filter(
        ({ args }) => args[0] === "run" && args[1] === "services" && args[2] === "delete"
      )
    ).toHaveLength(2);
    expect(fake.gcloud.find("run services delete pagelet ")).toBeDefined();
    expect(fake.gcloud.find("run services delete pagelet-creator")).toBeDefined();
    expect(fake.gcloud.find("secrets delete pagelet-session-secret")).toBeDefined();
    expect(fake.gcloud.find("artifacts repositories delete")).toBeDefined();
    expect(fake.gcloud.find("service-accounts delete")).toBeDefined();
    expect(output).toContain(`still in gs://${BUCKET}`);
  });

  it("names the target project before the plan", async () => {
    const fake = createFakeAdmin({ gcloud: MANAGED, confirms: [true] });
    await runAdmin(BASE_ARGS, fake.deps);
    const output = fake.io.lines.join("\n");

    expect(output).toContain("Configuration");
    expect(output).toContain("project           demo-project  (--project)");
    expect(output.indexOf("Configuration")).toBeLessThan(output.indexOf("Plan"));
  });

  it("refuses to run without --project, naming the default it did not use", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        {
          when: "config list",
          reply: { stdout: JSON.stringify({ core: { project: "some-other-project" } }) }
        },
        ...MANAGED
      ],
      confirms: [true]
    });
    const result = await runAdmin(["destroy"], fake.deps);
    const errors = fake.io.errors.join("\n");

    expect(result.exitCode).toBe(1);
    expect(errors).toContain("requires --project");
    expect(errors).toContain("some-other-project");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("warns when the target region is empty but services live elsewhere", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services list",
          reply: {
            stdout: JSON.stringify([
              {
                metadata: {
                  labels: {
                    "pagelet-managed": "true",
                    "cloud.googleapis.com/location": "us-west1"
                  }
                }
              }
            ])
          }
        }
      ]
    });
    const result = await runAdmin(BASE_ARGS, fake.deps);
    const errors = fake.io.errors.join("\n");

    expect(result.exitCode).toBe(1);
    expect(errors).toContain("no Pagelet services in us-central1");
    expect(errors).toContain("us-west1");
    expect(errors).toContain("--region us-west1");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("stays quiet about other regions when the target region has services", async () => {
    const fake = createFakeAdmin({ gcloud: MANAGED, confirms: [true] });
    await runAdmin(BASE_ARGS, fake.deps);

    expect(fake.io.errors.join("\n")).not.toContain("no Pagelet services");
    expect(fake.gcloud.find("run services list")).toBeUndefined();
  });

  it("deletes nothing when the typed bucket name does not match", async () => {
    const fake = createFakeAdmin({
      gcloud: MANAGED,
      confirms: [true],
      answers: ["wrong-bucket"]
    });
    const result = await runAdmin([...BASE_ARGS, "--delete-data"], fake.deps);

    expect(result.exitCode).toBe(1);
    expect(fake.io.errors.join("\n")).toContain("did not match");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("deletes the bucket once the name is typed back", async () => {
    const fake = createFakeAdmin({
      gcloud: MANAGED,
      confirms: [true],
      answers: [BUCKET]
    });
    const result = await runAdmin([...BASE_ARGS, "--delete-data"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.gcloud.find(`storage rm --recursive gs://${BUCKET}`)).toBeDefined();
    expect(fake.io.lines.join("\n")).toContain("The Google Cloud project itself was not touched.");
  });

  it("skips the typed confirmation under --yes", async () => {
    const fake = createFakeAdmin({ gcloud: MANAGED });
    const result = await runAdmin([...BASE_ARGS, "--delete-data", "--yes"], fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.prompts).toEqual([]);
    expect(fake.gcloud.find("storage rm")).toBeDefined();
  });

  it("reaches a non-default bucket through --bucket once the service is gone", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        { when: "storage buckets describe", reply: { stdout: managedLabels() } }
      ],
      confirms: [true],
      answers: ["my-reports"]
    });
    const result = await runAdmin(
      [...BASE_ARGS, "--bucket", "my-reports", "--delete-data"],
      fake.deps
    );

    expect(result.exitCode).toBe(0);
    expect(fake.gcloud.call("storage rm").args).toContain("gs://my-reports");
  });

  it("skips resources it does not manage", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...PREFLIGHT,
        {
          when: "run services describe",
          reply: { stdout: runServiceJson({ url: LIVE_URL, managed: false }) }
        },
        {
          when: "secrets describe pagelet-session-secret",
          reply: { stdout: JSON.stringify({ labels: {} }) }
        },
        { when: "storage buckets describe", reply: { stdout: JSON.stringify({ labels: {} }) } }
      ]
    });
    const result = await runAdmin(BASE_ARGS, fake.deps);
    const output = fake.io.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("skipped Cloud Run service pagelet: not managed by pagelet admin");
    expect(output).toContain("skipped secret pagelet-session-secret");
    expect(output).toContain(`skipped bucket gs://${BUCKET}`);
    expect(output).toContain("Nothing to delete.");
    expect(fake.gcloud.mutations()).toEqual([]);
  });

  it("tolerates resources that are already gone", async () => {
    const fake = createFakeAdmin({
      gcloud: [
        ...MANAGED,
        {
          when: "run services delete",
          reply: { code: 1, stderr: "ERROR: Service pagelet not found" }
        }
      ],
      confirms: [true]
    });
    const result = await runAdmin(BASE_ARGS, fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.io.lines.join("\n")).toContain("was already gone");
  });
});
