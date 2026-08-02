/**
 * The repository surface used by routes.
 *
 * There is one implementation. Which storage it lands on — the local
 * filesystem or a bucket — is decided one layer down, by the document store
 * driver, so nothing above this line has to know or care.
 */
export {
  createCommentReply,
  createCommentThread,
  createPageletDraft,
  createVersionDraft,
  exportFeedbackMarkdown,
  finalizeVersion,
  getPagelet,
  getPublishConfig,
  listComments,
  putDraftUpload,
  readVersionAsset,
  readVersionHtml,
  updateCommentThread
} from "./pagelet-store";
