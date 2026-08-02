import { describe, expect, it } from "vitest";
import {
  formatExternalReferenceNotices,
  getHelpText,
  isPageletUploadUrl,
  runCli
} from "./index.js";

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
