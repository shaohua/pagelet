/**
 * The repository, stored as JSON documents.
 *
 * A pagelet keeps everything mutable about itself in one document: the pagelet
 * row, its versions, and its comment threads. They are always read together
 * when rendering the viewer, and their writers are equally rare, so one
 * document means one round-trip and one thing to keep consistent. Writers only
 * contend when acting on the same report at the same moment.
 *
 *   pagelets/{shareId}   pagelet, versions, comment threads
 *   drafts/{draftId}     in-flight publishes
 *   threads/{threadId}   pointer to the owning pagelet
 *
 * The thread pointer exists because comment routes are keyed by thread id
 * alone. It is written once when a thread is created, and it saves scanning
 * every pagelet to answer "which report owns this thread?".
 *
 * Publishing commits by pointer: assets upload first, and the pagelet document
 * is written last. An interrupted publish leaves orphaned assets, never a
 * pagelet referring to a version that was never finished.
 */
import { randomBytes, randomUUID, type UUID } from "node:crypto";
import type {
  CommentThread,
  CreatePageletDraftRequest,
  CreatePageletDraftResponse,
  CreateCommentReplyRequest,
  CreateCommentThreadRequest,
  CreateVersionDraftRequest,
  DraftUploadFile,
  FinalizeVersionRequest,
  FinalizeVersionResponse,
  GetPageletResponse,
  GetPublishConfigResponse,
  ListCommentsResponse,
  Pagelet,
  PageletVersion,
  PublishDraft,
  UpdateCommentThreadRequest
} from "@pagelet/shared";
import {
  demoOrganization,
  demoPublishConfig,
  demoUser,
  renderFeedbackMarkdown
} from "@pagelet/shared";
import { getAllowedExternalOrigins } from "./config";
import { getDocumentStore, type DocumentStore } from "./document-store";
import {
  getStorageAdapter,
  type StoredObjectMetadata,
  type StoredUploadTarget
} from "./storage-adapter";

type StoredDraft = PublishDraft & {
  shareId: string;
  uploadTargets: StoredUploadTarget[];
  message: string | null;
};

/** Everything mutable about one report. */
type PageletRecord = {
  pagelet: Pagelet;
  versions: PageletVersion[];
  threads: CommentThread[];
};

type ThreadPointer = { shareId: string };

const pageletKey = (shareId: string) => `pagelets/${shareId}`;
const draftKey = (draftId: string) => `drafts/${draftId}`;
const threadKey = (threadId: string) => `threads/${threadId}`;

function documents(): DocumentStore {
  return getDocumentStore();
}

export async function getPublishConfig(): Promise<GetPublishConfigResponse> {
  return {
    ...demoPublishConfig,
    allowedExternalOrigins: getAllowedExternalOrigins()
  };
}

export async function createPageletDraft(
  request: CreatePageletDraftRequest,
  appBaseUrl: string
): Promise<CreatePageletDraftResponse> {
  const now = new Date().toISOString();
  const shareId = createShareId();
  const pagelet: Pagelet = {
    id: randomUUID(),
    orgId: demoOrganization.id,
    ownerUserId: demoUser.id,
    shareId,
    slug: request.slug ?? slugify(request.title),
    title: request.title,
    visibility: "domain_private",
    latestVersionId: null,
    versionCount: 0,
    createdAt: now,
    updatedAt: now
  };

  await documents().write<PageletRecord>(
    pageletKey(shareId),
    { pagelet, versions: [], threads: [] },
    null
  );

  const draft = createDraftRecord({
    files: request.files,
    orgId: pagelet.orgId,
    pageletId: pagelet.id,
    shareId,
    plannedVersionId: randomUUID(),
    plannedVersionNumber: 1,
    message: request.message ?? null,
    now
  });
  await documents().write<StoredDraft>(draftKey(draft.id), draft, null);

  return draftResponse(pagelet, draft, appBaseUrl);
}

export async function createVersionDraft(
  shareId: string,
  request: CreateVersionDraftRequest,
  appBaseUrl: string
): Promise<CreatePageletDraftResponse> {
  const record = await requireRecord(shareId);
  const draft = createDraftRecord({
    files: request.files,
    orgId: record.pagelet.orgId,
    pageletId: record.pagelet.id,
    shareId,
    plannedVersionId: randomUUID(),
    plannedVersionNumber: record.pagelet.versionCount + 1,
    message: request.message ?? null,
    now: new Date().toISOString()
  });

  await documents().write<StoredDraft>(draftKey(draft.id), draft, null);

  return draftResponse(record.pagelet, draft, appBaseUrl);
}

export async function putDraftUpload(
  draftId: string,
  fileIndex: number,
  bytes: ArrayBuffer
): Promise<void> {
  const draft = await requireDraft(draftId);
  await assertDraftAcceptsWrites(draft);

  const target = draft.uploadTargets[fileIndex];

  if (!target) {
    throw new Response("Upload target not found", { status: 404 });
  }

  const expectedFile = draft.expectedFiles[fileIndex];

  if (!expectedFile) {
    throw new Response("Expected upload file not found", { status: 404 });
  }

  await getStorageAdapter().putObject(
    target.gcsObject,
    Buffer.from(bytes),
    expectedFile.contentType
  );

  await documents().mutate<StoredDraft>(draftKey(draftId), (current) => {
    if (!current) {
      throw new Response("Draft not found", { status: 404 });
    }

    const uploadTargets = current.uploadTargets.map((item, index) =>
      index === fileIndex
        ? { ...item, uploadedAt: new Date().toISOString() }
        : item
    );

    return { ...current, uploadTargets };
  });
}

export async function finalizeVersion(
  shareId: string,
  draftId: string,
  request: FinalizeVersionRequest,
  appBaseUrl: string
): Promise<FinalizeVersionResponse> {
  const record = await requireRecord(shareId);
  const draft = await requireDraft(draftId);

  if (draft.pageletId !== record.pagelet.id) {
    throw new Response("Draft does not belong to pagelet", { status: 400 });
  }

  // Finalizing twice is not an error: the CLI retries, and the version is
  // already durable.
  const existingVersion = record.versions.find(
    (version) => version.id === draft.plannedVersionId
  );

  if (existingVersion) {
    return finalizeResponse(record.pagelet, existingVersion, appBaseUrl);
  }

  await assertDraftAcceptsWrites(draft);

  const htmlTarget = draft.uploadTargets.find(
    (target) => target.gcsObject === request.htmlObject
  );

  if (!htmlTarget) {
    throw new Response("HTML object was not uploaded", { status: 400 });
  }

  const uploadMetadata = await verifyDraftUploads(draft);
  const htmlMetadata = uploadMetadata.get(htmlTarget.gcsObject);

  if (!htmlMetadata) {
    throw new Response("HTML object was not uploaded", { status: 400 });
  }

  if (
    htmlMetadata.sha256 !== request.sha256 ||
    htmlMetadata.sizeBytes !== request.sizeBytes
  ) {
    throw new Response(
      "Uploaded HTML metadata does not match finalize request",
      { status: 400 }
    );
  }

  const createdAt = new Date().toISOString();
  const version: PageletVersion = {
    id: draft.plannedVersionId,
    pageletId: record.pagelet.id,
    versionNumber: draft.plannedVersionNumber,
    parentVersionId: record.pagelet.latestVersionId,
    gcsHtmlObject: request.htmlObject,
    gcsJournalObject: request.journalObject ?? null,
    assetManifest: request.assetManifest,
    sha256: request.sha256,
    sizeBytes: request.sizeBytes,
    message: draft.message,
    createdByUserId: demoUser.id,
    createdAt
  };

  // The pointer write. Everything the version needs is already in storage, so
  // this is the step that makes it visible.
  const updated = await documents().mutate<PageletRecord>(
    pageletKey(shareId),
    (current) => {
      if (!current) {
        throw new Response("Pagelet not found", { status: 404 });
      }

      if (current.versions.some((item) => item.id === version.id)) {
        return current;
      }

      return {
        ...current,
        pagelet: {
          ...current.pagelet,
          latestVersionId: version.id,
          versionCount: Math.max(
            current.pagelet.versionCount,
            version.versionNumber
          ),
          updatedAt: createdAt
        },
        versions: [...current.versions, version]
      };
    }
  );

  await documents().mutate<StoredDraft>(draftKey(draftId), (current) => ({
    ...(current ?? draft),
    status: "finalized",
    finalizedAt: createdAt,
    uploadTargets: (current ?? draft).uploadTargets.map((target) => ({
      ...target,
      uploadedAt: target.uploadedAt ?? createdAt
    }))
  }));

  return finalizeResponse(updated.pagelet, version, appBaseUrl);
}

export async function getPagelet(
  shareId: string,
  versionNumber?: number
): Promise<GetPageletResponse> {
  const record = await requireRecord(shareId);
  const versions = [...record.versions].sort(
    (a, b) => a.versionNumber - b.versionNumber
  );

  if (versions.length === 0) {
    throw new Response("Pagelet has no finalized versions", { status: 404 });
  }

  const latestVersion = versions.find(
    (version) => version.id === record.pagelet.latestVersionId
  );

  if (!latestVersion) {
    throw new Response("Latest version not found", { status: 404 });
  }

  const currentVersion = versionNumber
    ? versions.find((version) => version.versionNumber === versionNumber)
    : latestVersion;

  if (!currentVersion) {
    throw new Response("Requested version not found", { status: 404 });
  }

  return {
    pagelet: record.pagelet,
    latestVersion,
    versions,
    currentVersion,
    unresolvedPreviousVersionCommentCount: record.threads.filter(
      (thread) =>
        thread.status === "open" && thread.versionId !== currentVersion.id
    ).length
  };
}

export async function readVersionHtml(
  shareId: string,
  versionParam: string
): Promise<{ html: string; version: PageletVersion }> {
  const record = await requireRecord(shareId);
  const version = selectVersion(record, versionParam);
  const html = await getStorageAdapter().getObject(
    version.gcsHtmlObject,
    "text/html; charset=utf-8"
  );

  return { html: html.bytes.toString("utf8"), version };
}

export async function readVersionAsset(
  shareId: string,
  versionParam: string,
  assetPath: string
): Promise<{ bytes: Buffer; contentType: string }> {
  const record = await requireRecord(shareId);
  const version = selectVersion(record, versionParam);
  const normalizedPath = normalizeAssetPath(assetPath);
  // Serving only what the version's manifest references is what stops a
  // crafted path from reaching another report's objects.
  const manifestEntry = version.assetManifest.find(
    (asset) => asset.rewrittenPath === `assets/${normalizedPath}`
  );

  if (!manifestEntry) {
    throw new Response("Asset not found", { status: 404 });
  }

  return getStorageAdapter().getObject(
    manifestEntry.gcsObject,
    manifestEntry.contentType
  );
}

export async function listComments(
  shareId: string,
  versionNumber?: number
): Promise<ListCommentsResponse> {
  const [record, pageletResponse] = await Promise.all([
    requireRecord(shareId),
    getPagelet(shareId, versionNumber)
  ]);

  const threads = record.threads
    .filter((thread) => thread.versionId === pageletResponse.currentVersion.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return { threads };
}

export async function createCommentThread(
  shareId: string,
  request: CreateCommentThreadRequest
): Promise<{ thread: CommentThread }> {
  const now = new Date().toISOString();
  const threadId = randomUUID();
  let created: CommentThread | null = null;

  await documents().mutate<PageletRecord>(pageletKey(shareId), (current) => {
    if (!current) {
      throw new Response("Pagelet not found", { status: 404 });
    }

    const version = current.versions.find(
      (item) => item.id === request.versionId
    );

    if (!version) {
      throw new Response("Version not found for comment", { status: 404 });
    }

    const thread: CommentThread = {
      id: threadId,
      pageletId: current.pagelet.id,
      versionId: version.id,
      authorUserId: demoUser.id,
      kind: request.kind,
      priority: request.priority ?? "normal",
      status: "open",
      assigneeUserId: request.assigneeUserId ?? null,
      anchor: request.anchor ?? null,
      messages: [
        {
          id: randomUUID(),
          threadId,
          authorUserId: demoUser.id,
          bodyMarkdown: request.bodyMarkdown,
          mentionedUserIds: [],
          createdAt: now,
          updatedAt: now,
          editedAt: null
        }
      ],
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now
    };

    created = thread;
    return { ...current, threads: [...current.threads, thread] };
  });

  if (!created) {
    throw new Response("Comment thread was not created", { status: 500 });
  }

  await documents().write<ThreadPointer>(
    threadKey(threadId),
    { shareId },
    null
  );

  return { thread: created };
}

export async function createCommentReply(
  threadId: string,
  request: CreateCommentReplyRequest
): Promise<{ thread: CommentThread }> {
  const now = new Date().toISOString();

  return updateThread(threadId, (thread) => ({
    ...thread,
    messages: [
      ...thread.messages,
      {
        id: randomUUID(),
        threadId,
        authorUserId: demoUser.id,
        bodyMarkdown: request.bodyMarkdown,
        mentionedUserIds: [],
        createdAt: now,
        updatedAt: now,
        editedAt: null
      }
    ],
    updatedAt: now
  }));
}

export async function updateCommentThread(
  threadId: string,
  request: UpdateCommentThreadRequest
): Promise<{ thread: CommentThread }> {
  const now = new Date().toISOString();

  return updateThread(threadId, (thread) => {
    const next: CommentThread = { ...thread, updatedAt: now };

    if (request.priority) {
      next.priority = request.priority;
    }

    if ("assigneeUserId" in request) {
      next.assigneeUserId = request.assigneeUserId ?? null;
    }

    if (request.status) {
      next.status = request.status;
      next.resolvedByUserId = request.status === "resolved" ? demoUser.id : null;
      next.resolvedAt = request.status === "resolved" ? now : null;
    }

    return next;
  });
}

export async function exportFeedbackMarkdown({
  shareId,
  versionNumber,
  status = "open"
}: {
  shareId: string;
  versionNumber?: number;
  status?: "open" | "resolved" | "all";
}): Promise<string> {
  const [record, pageletResponse] = await Promise.all([
    requireRecord(shareId),
    getPagelet(shareId, versionNumber)
  ]);
  const currentVersion = pageletResponse.currentVersion;
  const threads = record.threads.filter((thread) => {
    if (thread.versionId !== currentVersion.id) {
      return false;
    }

    return status === "all" ? true : thread.status === status;
  });

  return renderFeedbackMarkdown({
    title: record.pagelet.title,
    shareId: record.pagelet.shareId,
    versionNumber: currentVersion.versionNumber,
    threads
  });
}

// ---------------------------------------------------------------------------

async function updateThread(
  threadId: string,
  apply: (thread: CommentThread) => CommentThread
): Promise<{ thread: CommentThread }> {
  const pointer = await documents().read<ThreadPointer>(threadKey(threadId));

  if (!pointer) {
    throw new Response("Comment thread not found", { status: 404 });
  }

  let updated: CommentThread | null = null;

  await documents().mutate<PageletRecord>(
    pageletKey(pointer.value.shareId),
    (current) => {
      if (!current) {
        throw new Response("Pagelet not found", { status: 404 });
      }

      const threads = current.threads.map((thread) => {
        if (thread.id !== threadId) {
          return thread;
        }

        updated = apply(thread);
        return updated;
      });

      if (!updated) {
        throw new Response("Comment thread not found", { status: 404 });
      }

      return { ...current, threads };
    }
  );

  if (!updated) {
    throw new Response("Comment thread not found", { status: 404 });
  }

  return { thread: updated };
}

async function requireRecord(shareId: string): Promise<PageletRecord> {
  const record = await documents().read<PageletRecord>(pageletKey(shareId));

  if (!record) {
    throw new Response("Pagelet not found", { status: 404 });
  }

  return record.value;
}

async function requireDraft(draftId: string): Promise<StoredDraft> {
  const draft = await documents().read<StoredDraft>(draftKey(draftId));

  if (!draft) {
    throw new Response("Draft not found", { status: 404 });
  }

  return draft.value;
}

function selectVersion(
  record: PageletRecord,
  versionParam: string
): PageletVersion {
  const version =
    versionParam === "latest"
      ? record.versions.find(
          (item) => item.id === record.pagelet.latestVersionId
        )
      : record.versions.find(
          (item) => item.versionNumber === Number(versionParam)
        );

  if (!version) {
    throw new Response("Version not found", { status: 404 });
  }

  return version;
}

async function assertDraftAcceptsWrites(draft: StoredDraft): Promise<void> {
  const expired =
    draft.status === "expired" ||
    (draft.status === "pending" && Date.parse(draft.expiresAt) <= Date.now());

  if (expired) {
    if (draft.status !== "expired") {
      await documents().mutate<StoredDraft>(draftKey(draft.id), (current) => ({
        ...(current ?? draft),
        status: "expired"
      }));
    }

    throw new Response("Publish draft expired", { status: 410 });
  }

  if (draft.status !== "pending") {
    throw new Response("Draft is not pending", { status: 400 });
  }
}

async function verifyDraftUploads(
  draft: StoredDraft
): Promise<Map<string, StoredObjectMetadata>> {
  const metadataByObject = new Map<string, StoredObjectMetadata>();

  for (const [index, target] of draft.uploadTargets.entries()) {
    const expectedFile = draft.expectedFiles[index];

    if (!expectedFile) {
      throw new Response(
        `Expected upload file not found: ${target.originalPath}`,
        { status: 400 }
      );
    }

    let metadata: StoredObjectMetadata;

    try {
      metadata = await getStorageAdapter().getObjectMetadata(target.gcsObject);
    } catch {
      throw new Response(`Missing uploaded file: ${target.originalPath}`, {
        status: 400
      });
    }

    if (
      metadata.sha256 !== expectedFile.sha256 ||
      metadata.sizeBytes !== expectedFile.sizeBytes
    ) {
      throw new Response(
        `Uploaded file metadata does not match expected file: ${target.originalPath}`,
        { status: 400 }
      );
    }

    metadataByObject.set(target.gcsObject, metadata);
  }

  return metadataByObject;
}

function createDraftRecord({
  files,
  orgId,
  pageletId,
  shareId,
  plannedVersionId,
  plannedVersionNumber,
  message,
  now
}: {
  files: DraftUploadFile[];
  orgId: string;
  pageletId: string;
  shareId: string;
  plannedVersionId: UUID;
  plannedVersionNumber: number;
  message: string | null;
  now: string;
}): StoredDraft {
  return {
    id: randomUUID(),
    orgId,
    pageletId,
    shareId,
    createdByUserId: demoUser.id,
    plannedVersionId,
    plannedVersionNumber,
    status: "pending",
    expectedFiles: files,
    uploadTargets: getStorageAdapter().createDraftUploadTargets({
      orgId,
      pageletId,
      versionId: plannedVersionId,
      files
    }),
    message,
    createdAt: now,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    finalizedAt: null
  };
}

async function draftResponse(
  pagelet: Pagelet,
  draft: StoredDraft,
  appBaseUrl: string
): Promise<CreatePageletDraftResponse> {
  return {
    pagelet,
    draftId: draft.id,
    plannedVersionId: draft.plannedVersionId,
    plannedVersionNumber: draft.plannedVersionNumber,
    assetBasePath: "assets",
    uploadUrls: await getStorageAdapter().createDraftUploadUrls({
      appBaseUrl,
      draftId: draft.id,
      expiresAt: draft.expiresAt,
      targets: draft.uploadTargets
    })
  };
}

function finalizeResponse(
  pagelet: Pagelet,
  version: PageletVersion,
  appBaseUrl: string
): FinalizeVersionResponse {
  const url = `${appBaseUrl}/p/${pagelet.shareId}`;

  return {
    pagelet,
    version,
    url,
    versionUrl: `${url}?v=${version.versionNumber}`
  };
}

function normalizeAssetPath(assetPath: string): string {
  const decoded = decodeURIComponent(assetPath);
  const parts = decoded.split("/").filter(Boolean);

  if (parts.some((part) => part === "." || part === "..")) {
    throw new Response("Invalid asset path", { status: 400 });
  }

  return parts.join("/");
}

function createShareId(): string {
  return `pl_${randomBytes(6).toString("base64url")}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "untitled-report";
}
