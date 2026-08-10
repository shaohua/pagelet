import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoOrganization, demoUser } from "@pagelet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminIo, type AdminIo } from "./admin/io.js";
import {
  formatExternalReferenceNotices,
  getHelpText,
  isPageletUploadUrl,
  runCli
} from "./index.js";

// Keeps the poll loop from spending its real 2s between attempts.
vi.mock("./wait.js", () => ({ sleep: () => Promise.resolve() }));

const VERIFICATION_URL = "https://viewer.test/cli-login/PL-TESTCODE";
const tempDirs: string[] = [];

function captureIo(): { io: AdminIo; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { ...createAdminIo(), out: (text) => lines.push(text) },
    lines
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

beforeEach(async () => {
  const configDir = await mkdtemp(join(tmpdir(), "pagelet-cli-test-"));
  tempDirs.push(configDir);

  // Without this the login test would overwrite the real ~/.pagelet/config.json.
  vi.stubEnv("PAGELET_CONFIG", join(configDir, "config.json"));
  vi.stubEnv("PAGELET_API_URL", "https://creator.test");
  vi.stubEnv("PAGELET_TOKEN", "");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.endsWith("/api/cli-login/start")) {
      return jsonResponse({
        verificationUrl: VERIFICATION_URL,
        userCode: "PL-TESTCODE",
        pollUrl: "https://creator.test/api/cli-login/poll",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }

    if (url.endsWith("/api/cli-login/poll")) {
      return jsonResponse({
        status: "complete",
        token: "test-token",
        user: demoUser,
        organization: demoOrganization
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("pagelet cli skeleton", () => {
  it("prints help", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pagelet login");
    expect(result.stdout).toContain("pagelet publish <file>");
    expect(result.stderr).toBe("");
  });

  it("prints the version from package.json", async () => {
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Matches the manifest rather than a pinned literal, so bumping the
    // version does not break this test.
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("keeps publish visible as the next skeleton command", async () => {
    const result = await runCli(["publish"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: pagelet publish <file>");
  });

  it("validates login options before making API requests", async () => {
    const result = await runCli(["login", "--label"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown or incomplete login option");
  });

  /**
   * The caller prints `stdout` only once the command resolves, so a URL that
   * reaches the user through `stdout` is a URL they cannot see until the wait
   * is over — which is far too late to approve the login.
   */
  it("streams the verification URL rather than buffering it into stdout", async () => {
    const { io, lines } = captureIo();
    const result = await runCli(["login"], { io });

    expect(result.exitCode).toBe(0);
    expect(lines).toContain(`Open: ${VERIFICATION_URL}`);
    expect(lines).toContain("Code: PL-TESTCODE");
    expect(result.stdout).not.toContain(VERIFICATION_URL);
    expect(result.stdout).toContain("Logged in as");
  });

  it("streams the verification URL on the --no-wait path too", async () => {
    const { io, lines } = captureIo();
    const result = await runCli(["login", "--no-wait"], { io });

    expect(result.exitCode).toBe(0);
    expect(lines).toContain(`Open: ${VERIFICATION_URL}`);
    expect(result.stdout).toBe("");
  });

  it("has concise help text", () => {
    expect(getHelpText().split("\n").length).toBeLessThan(20);
  });

  it("formats external asset notices and warnings", () => {
    const notice = formatExternalReferenceNotices(
      [
        {
          url: "https://cdn.example.com/chart.js",
          origin: "https://cdn.example.com"
        },
        {
          url: "https://blocked.example.com/image.png",
          origin: "https://blocked.example.com"
        }
      ],
      ["https://cdn.example.com"]
    );

    expect(notice).toContain("Notice: external asset origin is allowed");
    expect(notice).toContain("https://cdn.example.com (1 reference)");
    expect(notice).toContain("Warning: external asset origin is not allow-listed");
    expect(notice).toContain("https://blocked.example.com (1 reference)");
  });

  it("distinguishes Pagelet upload URLs from external signed URLs", () => {
    expect(
      isPageletUploadUrl(
        "http://127.0.0.1:3000/api/uploads/draft_1/0",
        "http://127.0.0.1:3000"
      )
    ).toBe(true);
    expect(
      isPageletUploadUrl(
        "https://storage.googleapis.com/pagelet-bucket/object?X-Goog-Signature=abc",
        "http://127.0.0.1:3000"
      )
    ).toBe(false);
  });
});
