import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftUploadFile } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getStorageAdapter } from "./storage-adapter";

const savedStorageDir = process.env.PAGELET_STORAGE_DIR;
const savedStorageBackend = process.env.PAGELET_STORAGE_BACKEND;
const savedGcsUploadMode = process.env.PAGELET_GCS_UPLOAD_MODE;
const savedGcsBucket = process.env.GCS_BUCKET;
const storageDirs: string[] = [];

afterEach(async () => {
  if (savedStorageDir === undefined) {
    delete process.env.PAGELET_STORAGE_DIR;
  } else {
    process.env.PAGELET_STORAGE_DIR = savedStorageDir;
  }

  if (savedStorageBackend === undefined) {
    delete process.env.PAGELET_STORAGE_BACKEND;
  } else {
    process.env.PAGELET_STORAGE_BACKEND = savedStorageBackend;
  }

  if (savedGcsUploadMode === undefined) {
    delete process.env.PAGELET_GCS_UPLOAD_MODE;
  } else {
    process.env.PAGELET_GCS_UPLOAD_MODE = savedGcsUploadMode;
  }

  if (savedGcsBucket === undefined) {
    delete process.env.GCS_BUCKET;
  } else {
    process.env.GCS_BUCKET = savedGcsBucket;
  }

  await Promise.all(
    storageDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("storage adapter", () => {
  it("creates GCS-shaped upload target object names", () => {
    const htmlFile: DraftUploadFile = {
      role: "html",
      originalPath: "report.html",
      rewrittenPath: "report.html",
      contentType: "text/html; charset=utf-8",
      sizeBytes: 10,
      sha256: "a".repeat(64)
    };
    const assetFile: DraftUploadFile = {
      role: "asset",
      originalPath: "images/chart.svg",
      rewrittenPath: "assets/abc123/chart.svg",
      contentType: "image/svg+xml",
      sizeBytes: 11,
      sha256: "b".repeat(64)
    };

    const targets = getStorageAdapter().createDraftUploadTargets({
      orgId: "org_1",
      pageletId: "pagelet_1",
      versionId: "version_1",
      files: [htmlFile, assetFile]
    });

    expect(targets.map((target) => target.gcsObject)).toEqual([
      "orgs/org_1/pagelets/pagelet_1/versions/version_1/report.html",
      "orgs/org_1/pagelets/pagelet_1/versions/version_1/assets/abc123/chart.svg"
    ]);
  });

  it("creates local upload URLs for draft targets", async () => {
    const [target] = getStorageAdapter().createDraftUploadTargets({
      orgId: "org_1",
      pageletId: "pagelet_1",
      versionId: "version_1",
      files: [
        {
          role: "html",
          originalPath: "report.html",
          rewrittenPath: "report.html",
          contentType: "text/html; charset=utf-8",
          sizeBytes: 10,
          sha256: "a".repeat(64)
        }
      ]
    });

    if (!target) {
      throw new Error("Expected upload target");
    }

    await expect(
      getStorageAdapter().createDraftUploadUrls({
        appBaseUrl: "http://127.0.0.1:3000",
        draftId: "draft_1",
        expiresAt: "2026-01-01T00:10:00.000Z",
        targets: [target]
      })
    ).resolves.toEqual([
      {
        originalPath: "report.html",
        gcsObject: target.gcsObject,
        uploadUrl: "http://127.0.0.1:3000/api/uploads/draft_1/0",
        expiresAt: "2026-01-01T00:10:00.000Z"
      }
    ]);
  });

  it("requires a GCS bucket when the GCS backend is enabled", () => {
    process.env.PAGELET_STORAGE_BACKEND = "gcs";
    delete process.env.GCS_BUCKET;

    expect(() => getStorageAdapter()).toThrow(
      "GCS_BUCKET is required when PAGELET_STORAGE_BACKEND=gcs"
    );
  });

  it("uses proxied upload URLs for the GCS backend by default", async () => {
    process.env.PAGELET_STORAGE_BACKEND = "gcs";
    process.env.GCS_BUCKET = "pagelet-test-bucket";
    delete process.env.PAGELET_GCS_UPLOAD_MODE;

    const [target] = getStorageAdapter().createDraftUploadTargets({
      orgId: "org_1",
      pageletId: "pagelet_1",
      versionId: "version_1",
      files: [
        {
          role: "html",
          originalPath: "report.html",
          rewrittenPath: "report.html",
          contentType: "text/html; charset=utf-8",
          sizeBytes: 10,
          sha256: "a".repeat(64)
        }
      ]
    });

    if (!target) {
      throw new Error("Expected upload target");
    }

    await expect(
      getStorageAdapter().createDraftUploadUrls({
        appBaseUrl: "https://pagelet.example.com",
        draftId: "draft_1",
        expiresAt: "2026-01-01T00:10:00.000Z",
        targets: [target]
      })
    ).resolves.toEqual([
      {
        originalPath: "report.html",
        gcsObject: target.gcsObject,
        uploadUrl: "https://pagelet.example.com/api/uploads/draft_1/0",
        expiresAt: "2026-01-01T00:10:00.000Z"
      }
    ]);
  });

  it("writes, reads, and computes local object metadata", async () => {
    await useTempStorage();
    const bytes = Buffer.from("<svg></svg>");
    const objectName =
      "orgs/org_1/pagelets/pagelet_1/versions/version_1/assets/abc/chart.svg";

    await getStorageAdapter().putObject(objectName, bytes, "image/svg+xml");

    await expect(
      getStorageAdapter().getObject(objectName, "image/svg+xml")
    ).resolves.toEqual({
      bytes,
      contentType: "image/svg+xml"
    });
    await expect(getStorageAdapter().getObjectMetadata(objectName)).resolves.toEqual({
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  });
});

async function useTempStorage(): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "pagelet-storage-adapter-"));
  storageDirs.push(storageDir);
  process.env.PAGELET_STORAGE_DIR = storageDir;
}
