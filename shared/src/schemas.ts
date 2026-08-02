import { z } from "zod";

export const isoDateStringSchema = z.string().datetime({ offset: true });
export const idSchema = z.string().uuid();
export const shareIdSchema = z.string().regex(/^pl_[a-zA-Z0-9_-]{6,}$/);

export const organizationSchema = z.object({
  id: idSchema,
  primaryDomain: z.string().min(1),
  allowedDomains: z.array(z.string().min(1)).min(1),
  name: z.string().nullable(),
  createdAt: isoDateStringSchema
});

export const userSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  email: z.string().email(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  createdAt: isoDateStringSchema
});

export const pageletSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  ownerUserId: idSchema,
  shareId: shareIdSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  visibility: z.literal("domain_private"),
  latestVersionId: idSchema.nullable(),
  versionCount: z.number().int().nonnegative(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema
});

export const draftUploadFileSchema = z.object({
  role: z.enum(["html", "asset", "journal"]),
  originalPath: z.string().min(1),
  rewrittenPath: z.string().min(1).optional(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const publishDraftSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  pageletId: idSchema,
  createdByUserId: idSchema,
  plannedVersionId: idSchema,
  plannedVersionNumber: z.number().int().positive(),
  status: z.enum(["pending", "finalized", "expired"]),
  expectedFiles: z.array(draftUploadFileSchema),
  createdAt: isoDateStringSchema,
  expiresAt: isoDateStringSchema,
  finalizedAt: isoDateStringSchema.nullable()
});

export const versionAssetSchema = z.object({
  originalPath: z.string().min(1),
  rewrittenPath: z.string().min(1),
  gcsObject: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const pageletVersionSchema = z.object({
  id: idSchema,
  pageletId: idSchema,
  versionNumber: z.number().int().positive(),
  parentVersionId: idSchema.nullable(),
  gcsHtmlObject: z.string().min(1),
  gcsJournalObject: z.string().min(1).nullable(),
  assetManifest: z.array(versionAssetSchema),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  message: z.string().nullable(),
  createdByUserId: idSchema,
  createdAt: isoDateStringSchema
});

export const commentAnchorSchema = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  documentWidth: z.number().positive(),
  documentHeight: z.number().positive(),
  viewportWidth: z.number().positive(),
  viewportHeight: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
  selector: z.string().optional(),
  textFingerprint: z.string().optional(),
  quotedText: z.string().optional()
});

export const commentMessageSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  authorUserId: idSchema,
  bodyMarkdown: z.string().min(1),
  mentionedUserIds: z.array(idSchema),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
  editedAt: isoDateStringSchema.nullable()
});

// Kinds name the edit the agent should make, not the topic the comment is
// about. A reviewer picking "delete" is giving an instruction; picking
// "data_source" was only giving a label.
export const commentThreadKindSchema = z.enum([
  "change_request",
  "replace",
  "delete",
  "question",
  "approve",
  "note"
]);

export const commentPrioritySchema = z.enum(["normal", "high", "blocking"]);
export const commentStatusSchema = z.enum(["open", "resolved"]);

export const commentThreadSchema = z.object({
  id: idSchema,
  pageletId: idSchema,
  versionId: idSchema,
  authorUserId: idSchema,
  kind: commentThreadKindSchema,
  priority: commentPrioritySchema,
  status: commentStatusSchema,
  assigneeUserId: idSchema.nullable(),
  // Null for feedback about the report as a whole, which has no element to
  // point at — "this is too long" needs somewhere to live.
  anchor: commentAnchorSchema.nullable(),
  messages: z.array(commentMessageSchema),
  resolvedByUserId: idSchema.nullable(),
  resolvedAt: isoDateStringSchema.nullable(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema
});

export const reviewNotificationSchema = z.object({
  id: idSchema,
  userId: idSchema,
  pageletId: idSchema,
  versionId: idSchema,
  threadId: idSchema,
  messageId: idSchema.nullable(),
  kind: z.enum(["new_thread", "reply", "mention", "assigned"]),
  readAt: isoDateStringSchema.nullable(),
  createdAt: isoDateStringSchema
});

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional()
  })
});

export const getPublishConfigResponseSchema = z.object({
  maxUploadBytes: z.number().int().positive(),
  allowedExternalOrigins: z.array(z.string().url())
});

export const startCliLoginRequestSchema = z.object({
  label: z.string().min(1).optional()
});

export const startCliLoginResponseSchema = z.object({
  verificationUrl: z.string().url(),
  userCode: z.string().min(1),
  pollUrl: z.string().min(1),
  expiresAt: isoDateStringSchema
});

export const pollCliLoginRequestSchema = z.object({
  userCode: z.string().min(1)
});

export const pollCliLoginResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("complete"),
    token: z.string().min(1),
    user: userSchema,
    organization: organizationSchema
  })
]);

export const createPageletDraftRequestSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1).optional(),
  message: z.string().optional(),
  files: z.array(draftUploadFileSchema).min(1)
});

export const draftUploadUrlSchema = z.object({
  originalPath: z.string().min(1),
  gcsObject: z.string().min(1),
  uploadUrl: z.string().min(1),
  expiresAt: isoDateStringSchema
});

export const createPageletDraftResponseSchema = z.object({
  pagelet: pageletSchema,
  draftId: idSchema,
  plannedVersionId: idSchema,
  plannedVersionNumber: z.number().int().positive(),
  assetBasePath: z.string().min(1),
  uploadUrls: z.array(draftUploadUrlSchema)
});

export const createVersionDraftRequestSchema = z.object({
  message: z.string().optional(),
  files: z.array(draftUploadFileSchema).min(1)
});

export const createVersionDraftResponseSchema =
  createPageletDraftResponseSchema;

export const finalizeVersionRequestSchema = z.object({
  htmlObject: z.string().min(1),
  journalObject: z.string().min(1).optional(),
  assetManifest: z.array(versionAssetSchema),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative()
});

export const finalizeVersionResponseSchema = z.object({
  pagelet: pageletSchema,
  version: pageletVersionSchema,
  url: z.string().url(),
  versionUrl: z.string().url()
});

export const getPageletResponseSchema = z.object({
  pagelet: pageletSchema,
  latestVersion: pageletVersionSchema,
  versions: z.array(pageletVersionSchema),
  currentVersion: pageletVersionSchema,
  unresolvedPreviousVersionCommentCount: z.number().int().nonnegative()
});

export const listCommentsResponseSchema = z.object({
  threads: z.array(commentThreadSchema)
});

export const createCommentThreadRequestSchema = z.object({
  versionId: idSchema,
  kind: commentThreadKindSchema,
  priority: commentPrioritySchema.optional(),
  assigneeUserId: idSchema.nullable().optional(),
  bodyMarkdown: z.string().min(1),
  anchor: commentAnchorSchema.nullish()
});

export const createCommentThreadResponseSchema = z.object({
  thread: commentThreadSchema
});

export const createCommentReplyRequestSchema = z.object({
  bodyMarkdown: z.string().min(1)
});

export const createCommentReplyResponseSchema = z.object({
  thread: commentThreadSchema
});

export const updateCommentThreadRequestSchema = z.object({
  status: commentStatusSchema.optional(),
  priority: commentPrioritySchema.optional(),
  assigneeUserId: idSchema.nullable().optional()
});

export const updateCommentThreadResponseSchema = z.object({
  thread: commentThreadSchema
});

export const listReviewNotificationsResponseSchema = z.object({
  notifications: z.array(reviewNotificationSchema)
});

export const markReviewNotificationReadRequestSchema = z.object({
  read: z.boolean()
});

export const markReviewNotificationReadResponseSchema = z.object({
  notification: reviewNotificationSchema
});

export type Organization = z.infer<typeof organizationSchema>;
export type User = z.infer<typeof userSchema>;
export type Pagelet = z.infer<typeof pageletSchema>;
export type DraftUploadFile = z.infer<typeof draftUploadFileSchema>;
export type PublishDraft = z.infer<typeof publishDraftSchema>;
export type VersionAsset = z.infer<typeof versionAssetSchema>;
export type PageletVersion = z.infer<typeof pageletVersionSchema>;
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentMessage = z.infer<typeof commentMessageSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
export type CommentThreadKind = z.infer<typeof commentThreadKindSchema>;
export type ReviewNotification = z.infer<typeof reviewNotificationSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type GetPublishConfigResponse = z.infer<
  typeof getPublishConfigResponseSchema
>;
export type StartCliLoginRequest = z.infer<typeof startCliLoginRequestSchema>;
export type StartCliLoginResponse = z.infer<typeof startCliLoginResponseSchema>;
export type PollCliLoginRequest = z.infer<typeof pollCliLoginRequestSchema>;
export type PollCliLoginResponse = z.infer<typeof pollCliLoginResponseSchema>;
export type CreatePageletDraftRequest = z.infer<
  typeof createPageletDraftRequestSchema
>;
export type DraftUploadUrl = z.infer<typeof draftUploadUrlSchema>;
export type CreatePageletDraftResponse = z.infer<
  typeof createPageletDraftResponseSchema
>;
export type CreateVersionDraftRequest = z.infer<
  typeof createVersionDraftRequestSchema
>;
export type CreateVersionDraftResponse = z.infer<
  typeof createVersionDraftResponseSchema
>;
export type FinalizeVersionRequest = z.infer<
  typeof finalizeVersionRequestSchema
>;
export type FinalizeVersionResponse = z.infer<
  typeof finalizeVersionResponseSchema
>;
export type GetPageletResponse = z.infer<typeof getPageletResponseSchema>;
export type ListCommentsResponse = z.infer<typeof listCommentsResponseSchema>;
export type CreateCommentThreadRequest = z.infer<
  typeof createCommentThreadRequestSchema
>;
export type CreateCommentThreadResponse = z.infer<
  typeof createCommentThreadResponseSchema
>;
export type CreateCommentReplyRequest = z.infer<
  typeof createCommentReplyRequestSchema
>;
export type CreateCommentReplyResponse = z.infer<
  typeof createCommentReplyResponseSchema
>;
export type UpdateCommentThreadRequest = z.infer<
  typeof updateCommentThreadRequestSchema
>;
export type UpdateCommentThreadResponse = z.infer<
  typeof updateCommentThreadResponseSchema
>;
