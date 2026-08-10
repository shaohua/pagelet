import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreatePageletDraftResponse } from "@pagelet/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDocumentStore } from "./document-store";
import { handleCreatePagelet } from "./handlers";

const savedEnv = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  PAGELET_DEV_TOKEN: process.env.PAGELET_DEV_TOKEN,
  PAGELET_STORAGE_DIR: process.env.PAGELET_STORAGE_DIR
};

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "pagelet-handlers-"));
  process.env.PAGELET_STORAGE_DIR = storageDir;
  process.env.NODE_ENV = "development";
  process.env.PAGELET_DEV_TOKEN = "test-token";
  resetDocumentStore();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  resetDocumentStore();
  await rm(storageDir, { force: true, recursive: true });
});

describe("draft handlers", () => {
  /**
   * APP_BASE_URL always names the viewer, but the viewer sits behind IAP and
   * refuses the CLI token. Upload URLs must name the creator service that
   * served the request, or publish fails with a 401 at the upload step.
   */
  it("builds upload URLs from the request origin, not APP_BASE_URL", async () => {
    process.env.APP_BASE_URL = "https://viewer.pagelet.test";

    const response = await handleCreatePagelet(
      new Request("http://internal.run.app/api/pagelets", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "x-forwarded-host": "creator.pagelet.test",
          "x-forwarded-proto": "https"
        },
        body: JSON.stringify({ title: "Split hosts", files: [htmlDraftFile()] })
      })
    );

    const draft = (await response.json()) as CreatePageletDraftResponse;

    expect(draft.uploadUrls[0]!.uploadUrl).toBe(
      `https://creator.pagelet.test/api/uploads/${draft.draftId}/0`
    );
  });
});

function htmlDraftFile() {
  const bytes = Buffer.from("<!doctype html><title>Split hosts</title>");

  return {
    role: "html",
    originalPath: "report.html",
    rewrittenPath: "report.html",
    contentType: "text/html; charset=utf-8",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
