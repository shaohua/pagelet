import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftUploadFile } from "@pagelet/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCommentReply,
  createCommentThread,
  createPageletDraft,
  createVersionDraft,
  exportFeedbackMarkdown,
  finalizeVersion,
  getPagelet,
  listComments,
  putDraftUpload,
  readVersionAsset,
  readVersionHtml,
  updateCommentThread
} from "./pagelet-store";
import { getDocumentStore, resetDocumentStore } from "./document-store";

const appBaseUrl = "http://127.0.0.1:3000";
const previousStorageDir = process.env.PAGELET_STORAGE_DIR;
let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "pagelet-store-"));
  process.env.PAGELET_STORAGE_DIR = storageDir;
  resetDocumentStore();
});

afterEach(async () => {
  if (previousStorageDir === undefined) {
    delete process.env.PAGELET_STORAGE_DIR;
  } else {
    process.env.PAGELET_STORAGE_DIR = previousStorageDir;
  }

  resetDocumentStore();
  await rm(storageDir, { force: true, recursive: true });
});

describe("publishing", () => {
  it("publishes a report and serves it back", async () => {
    const { shareId, version } = await publish("Quarterly report");

    expect(version.versionNumber).toBe(1);

    const served = await readVersionHtml(shareId, "latest");
    expect(served.html).toContain("Quarterly report");

    const pagelet = await getPagelet(shareId);
    expect(pagelet.pagelet.versionCount).toBe(1);
    expect(pagelet.currentVersion.id).toBe(version.id);
  });

  it("numbers republished versions and keeps earlier ones readable", async () => {
    const { shareId } = await publish("First");
    const second = await publishVersion(shareId, "Second");

    expect(second.version.versionNumber).toBe(2);
    await expect(readVersionHtml(shareId, "1")).resolves.toMatchObject({
      version: { versionNumber: 1 }
    });
    await expect(readVersionHtml(shareId, "latest")).resolves.toMatchObject({
      version: { versionNumber: 2 }
    });
  });

  it("treats a repeated finalize as the same version", async () => {
    const { shareId, draftId, htmlObject, htmlFile } = await publish("Retry");

    const again = await finalizeVersion(
      shareId,
      draftId,
      {
        htmlObject,
        assetManifest: [],
        sha256: htmlFile.sha256,
        sizeBytes: htmlFile.sizeBytes
      },
      appBaseUrl
    );

    expect(again.version.versionNumber).toBe(1);
    await expect(getPagelet(shareId)).resolves.toMatchObject({
      pagelet: { versionCount: 1 }
    });
  });

  it("rejects uploads and finalize once a draft has expired", async () => {
    const htmlBytes = Buffer.from("<!doctype html><title>Expired</title>");
    const htmlFile = htmlDraftFile(htmlBytes);
    const draft = await createPageletDraft(
      { title: "Expired", files: [htmlFile] },
      appBaseUrl
    );

    await expireDraft(draft.draftId);

    await expectStatus(
      putDraftUpload(draft.draftId, 0, toArrayBuffer(htmlBytes)),
      410
    );
    await expectStatus(
      finalizeVersion(
        draft.pagelet.shareId,
        draft.draftId,
        {
          htmlObject: draft.uploadUrls[0]!.gcsObject,
          assetManifest: [],
          sha256: htmlFile.sha256,
          sizeBytes: htmlFile.sizeBytes
        },
        appBaseUrl
      ),
      410
    );
  });

  it("rejects finalize when the uploaded bytes do not match the request", async () => {
    const htmlBytes = Buffer.from("<!doctype html><title>Mismatch</title>");
    const htmlFile = htmlDraftFile(htmlBytes);
    const draft = await createPageletDraft(
      { title: "Mismatch", files: [htmlFile] },
      appBaseUrl
    );
    await putDraftUpload(draft.draftId, 0, toArrayBuffer(htmlBytes));

    await expectStatus(
      finalizeVersion(
        draft.pagelet.shareId,
        draft.draftId,
        {
          htmlObject: draft.uploadUrls[0]!.gcsObject,
          assetManifest: [],
          sha256: sha256Hex(Buffer.from("something else")),
          sizeBytes: htmlFile.sizeBytes
        },
        appBaseUrl
      ),
      400
    );
  });

  it("serves only assets the version's manifest references", async () => {
    const htmlBytes = Buffer.from("<!doctype html><title>Assets</title>");
    const assetBytes = Buffer.from("console.log('hi');");
    const htmlFile = htmlDraftFile(htmlBytes);
    const assetSha = sha256Hex(assetBytes);
    const assetFile: DraftUploadFile = {
      role: "asset",
      originalPath: "scripts/report.js",
      rewrittenPath: `assets/${assetSha}/report.js`,
      contentType: "text/javascript",
      sizeBytes: assetBytes.byteLength,
      sha256: assetSha
    };

    const draft = await createPageletDraft(
      { title: "Assets", files: [htmlFile, assetFile] },
      appBaseUrl
    );
    await putDraftUpload(draft.draftId, 0, toArrayBuffer(htmlBytes));
    await putDraftUpload(draft.draftId, 1, toArrayBuffer(assetBytes));

    await finalizeVersion(
      draft.pagelet.shareId,
      draft.draftId,
      {
        htmlObject: draft.uploadUrls[0]!.gcsObject,
        assetManifest: [
          {
            originalPath: assetFile.originalPath,
            rewrittenPath: assetFile.rewrittenPath!,
            gcsObject: draft.uploadUrls[1]!.gcsObject,
            contentType: assetFile.contentType,
            sizeBytes: assetFile.sizeBytes,
            sha256: assetFile.sha256
          }
        ],
        sha256: htmlFile.sha256,
        sizeBytes: htmlFile.sizeBytes
      },
      appBaseUrl
    );

    const served = await readVersionAsset(
      draft.pagelet.shareId,
      "latest",
      `${assetSha}/report.js`
    );
    expect(served.bytes.toString("utf8")).toBe("console.log('hi');");

    await expectStatus(
      readVersionAsset(draft.pagelet.shareId, "latest", "not-in-manifest.js"),
      404
    );
    await expectStatus(
      readVersionAsset(draft.pagelet.shareId, "latest", "../secrets.js"),
      400
    );
  });

  it("reports a missing pagelet rather than inventing one", async () => {
    await expectStatus(getPagelet("pl_nope"), 404);
  });
});

describe("comments", () => {
  it("round-trips a thread, a reply, and resolution", async () => {
    const { shareId, version } = await publish("Commented");

    const { thread } = await createCommentThread(shareId, {
      versionId: version.id,
      kind: "replace",
      priority: "blocking",
      bodyMarkdown: "Should read 9%.",
      anchor: anchor()
    });

    await createCommentReply(thread.id, { bodyMarkdown: "Agreed." });

    const listed = await listComments(shareId);
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]!.messages).toHaveLength(2);

    await updateCommentThread(thread.id, { status: "resolved" });
    const afterResolve = await listComments(shareId);
    expect(afterResolve.threads[0]!.status).toBe("resolved");
  });

  it("carries the selector and quoted text into the feedback export", async () => {
    const { shareId, version } = await publish("Exported");

    await createCommentThread(shareId, {
      versionId: version.id,
      kind: "replace",
      priority: "blocking",
      bodyMarkdown: "Should read 9%.",
      anchor: anchor()
    });

    const markdown = await exportFeedbackMarkdown({ shareId });
    expect(markdown).toContain("Target: `main > p`");
    expect(markdown).toContain('Text: "Revenue grew 12%."');
    expect(markdown).toContain("Should read 9%.");
  });

  it("scopes feedback to the requested version", async () => {
    const { shareId, version } = await publish("Versioned");
    await createCommentThread(shareId, {
      versionId: version.id,
      kind: "change_request",
      bodyMarkdown: "Fix on v1.",
      anchor: anchor()
    });

    await publishVersion(shareId, "Versioned v2");

    // v2 carries no comments of its own; v1's stay with v1.
    expect(await exportFeedbackMarkdown({ shareId })).toContain(
      "No open review items"
    );
    expect(await exportFeedbackMarkdown({ shareId, versionNumber: 1 })).toContain(
      "Fix on v1."
    );
  });

  it("counts unresolved comments left behind on older versions", async () => {
    const { shareId, version } = await publish("Carryover");
    await createCommentThread(shareId, {
      versionId: version.id,
      kind: "question",
      bodyMarkdown: "Still open?",
      anchor: anchor()
    });
    await publishVersion(shareId, "Carryover v2");

    const pagelet = await getPagelet(shareId);
    expect(pagelet.unresolvedPreviousVersionCommentCount).toBe(1);
  });

  it("does not lose concurrent comments on the same report", async () => {
    const { shareId, version } = await publish("Busy");

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createCommentThread(shareId, {
          versionId: version.id,
          kind: "note",
          bodyMarkdown: `Comment ${index}`,
          anchor: anchor()
        })
      )
    );

    const listed = await listComments(shareId);
    expect(listed.threads).toHaveLength(12);
  });

  it("accepts a comment on the whole report, with no anchor", async () => {
    const { shareId, version } = await publish("Whole");

    const { thread } = await createCommentThread(shareId, {
      versionId: version.id,
      kind: "change_request",
      bodyMarkdown: "This runs too long; cut the middle section.",
      anchor: null
    });

    expect(thread.anchor).toBeNull();

    const markdown = await exportFeedbackMarkdown({ shareId });
    expect(markdown).toContain("Target: whole report");
    expect(markdown).toContain("cut the middle section");
  });

  it("reports a missing thread rather than silently succeeding", async () => {
    await expectStatus(
      createCommentReply("11111111-1111-4111-8111-111111111111", {
        bodyMarkdown: "Nobody home."
      }),
      404
    );
  });
});

// ---------------------------------------------------------------------------

async function publish(title: string) {
  const htmlBytes = Buffer.from(`<!doctype html><title>${title}</title>`);
  const htmlFile = htmlDraftFile(htmlBytes);
  const draft = await createPageletDraft({ title, files: [htmlFile] }, appBaseUrl);
  await putDraftUpload(draft.draftId, 0, toArrayBuffer(htmlBytes));

  const htmlObject = draft.uploadUrls[0]!.gcsObject;
  const finalized = await finalizeVersion(
    draft.pagelet.shareId,
    draft.draftId,
    {
      htmlObject,
      assetManifest: [],
      sha256: htmlFile.sha256,
      sizeBytes: htmlFile.sizeBytes
    },
    appBaseUrl
  );

  return {
    shareId: draft.pagelet.shareId,
    draftId: draft.draftId,
    htmlObject,
    htmlFile,
    version: finalized.version
  };
}

async function publishVersion(shareId: string, title: string) {
  const htmlBytes = Buffer.from(`<!doctype html><title>${title}</title>`);
  const htmlFile = htmlDraftFile(htmlBytes);
  const draft = await createVersionDraft(shareId, { files: [htmlFile] }, appBaseUrl);
  await putDraftUpload(draft.draftId, 0, toArrayBuffer(htmlBytes));

  return finalizeVersion(
    shareId,
    draft.draftId,
    {
      htmlObject: draft.uploadUrls[0]!.gcsObject,
      assetManifest: [],
      sha256: htmlFile.sha256,
      sizeBytes: htmlFile.sizeBytes
    },
    appBaseUrl
  );
}

function htmlDraftFile(bytes: Buffer): DraftUploadFile {
  return {
    role: "html",
    originalPath: "report.html",
    rewrittenPath: "report.html",
    contentType: "text/html; charset=utf-8",
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes)
  };
}

function anchor() {
  return {
    xPct: 10,
    yPct: 20,
    documentWidth: 1200,
    documentHeight: 3000,
    viewportWidth: 1200,
    viewportHeight: 800,
    scrollX: 0,
    scrollY: 0,
    selector: "main > p",
    textFingerprint: "18:abc123",
    quotedText: "Revenue grew 12%."
  };
}

async function expireDraft(draftId: string): Promise<void> {
  await getDocumentStore().mutate<{ expiresAt: string }>(
    `drafts/${draftId}`,
    (current) => ({ ...current!, expiresAt: "2000-01-01T00:00:00.000Z" })
  );
}

async function expectStatus(
  promise: Promise<unknown>,
  status: number
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status });
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

