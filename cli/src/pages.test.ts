import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pageRegistryPath,
  readPageBinding,
  writePageBinding
} from "./pages.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pagelet-pages-test-"));
  vi.stubEnv("PAGELET_PAGES", join(tempDir, "pages.json"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("page registry", () => {
  it("tracks HTML files in the same directory as different Pagelets", async () => {
    const first = join(tempDir, "1.html");
    const second = join(tempDir, "2.html");
    await writeFile(first, "<title>One</title>");
    await writeFile(second, "<title>Two</title>");

    await writePageBinding(first, {
      shareId: "pl_first1",
      title: "One",
      lastPublishedVersion: 1
    });
    await writePageBinding(second, {
      shareId: "pl_second2",
      title: "Two",
      lastPublishedVersion: 1
    });

    await expect(readPageBinding(first)).resolves.toMatchObject({
      shareId: "pl_first1"
    });
    await expect(readPageBinding(second)).resolves.toMatchObject({
      shareId: "pl_second2"
    });

    const registry = JSON.parse(await readFile(pageRegistryPath(), "utf8")) as {
      pages: Record<string, unknown>;
    };
    expect(Object.keys(registry.pages)).toEqual([
      await realpath(first),
      await realpath(second)
    ]);
  });

  it("updates the binding for the same file", async () => {
    const report = join(tempDir, "report.html");
    await writeFile(report, "<title>Report</title>");

    await writePageBinding(report, {
      shareId: "pl_report1",
      title: "Report",
      lastPublishedVersion: 1
    });
    await writePageBinding(report, {
      shareId: "pl_report1",
      title: "Report",
      lastPublishedVersion: 2
    });

    await expect(readPageBinding(report)).resolves.toEqual({
      shareId: "pl_report1",
      title: "Report",
      lastPublishedVersion: 2
    });
  });
});
