/**
 * The route table.
 *
 * This is the only file that knows about Hono: handlers take a web-standard
 * Request and the matched path parameters, and give back a Response.
 */
import { Hono } from "hono";
import {
  handleConfirmCliLogin,
  handleCreateComment,
  handleCreateCommentReply,
  handleCreatePagelet,
  handleCreateVersion,
  handleExportFeedback,
  handleFinalizeVersion,
  handleGetPagelet,
  handleGetPublishConfig,
  handleListComments,
  handlePollCliLogin,
  handleRenderVersion,
  handleRenderVersionAsset,
  handleStartCliLogin,
  handleUpdateCommentThread,
  handleUploadDraftFile
} from "./handlers";

export type PageletSurface = "viewer" | "creator" | "all";

export function createApp(
  options: Readonly<{ surface?: PageletSurface }> = {}
): Hono {
  const app = new Hono({ strict: false });
  const surface = options.surface ?? "all";

  app.use(async (c, next) => {
    // The store layer signals HTTP failures by throwing a Response. Hono only
    // routes thrown Errors to its error handler, so catch those here.
    try {
      await next();
    } catch (error) {
      if (!(error instanceof Response)) {
        throw error;
      }

      c.res = error;
    }
  });

  // Cloud Run reserves some paths ending in "z", which can catch conventional
  // healthz probes, so keep this endpoint on an ordinary path.
  app.get("/health", (c) => c.json({ ok: true, surface }));

  if (surface === "creator" || surface === "all") {
    registerCreatorRoutes(app);
  }

  if (surface === "viewer" || surface === "all") {
    registerViewerRoutes(app);
  }

  return app;
}

function registerCreatorRoutes(app: Hono): void {
  app.get("/api/publish-config", (c) => handleGetPublishConfig(c.req.raw));
  app.post("/api/pagelets", (c) => handleCreatePagelet(c.req.raw));
  app.get("/api/pagelets/:shareId/feedback.md", (c) =>
    handleExportFeedback(c.req.raw, c.req.param())
  );
  app.post("/api/pagelets/:shareId/versions", (c) =>
    handleCreateVersion(c.req.raw, c.req.param())
  );
  app.post("/api/pagelets/:shareId/versions/:draftId/finalize", (c) =>
    handleFinalizeVersion(c.req.raw, c.req.param())
  );
  app.put("/api/uploads/:draftId/:fileIndex", (c) =>
    handleUploadDraftFile(c.req.raw, c.req.param())
  );
  app.post("/api/cli-login/start", (c) => handleStartCliLogin(c.req.raw));
  app.post("/api/cli-login/poll", (c) => handlePollCliLogin(c.req.raw));
}

function registerViewerRoutes(app: Hono): void {
  app.get("/api/pagelets/:shareId", (c) =>
    handleGetPagelet(c.req.raw, c.req.param())
  );
  app.get("/api/pagelets/:shareId/comments", (c) =>
    handleListComments(c.req.raw, c.req.param())
  );
  app.post("/api/pagelets/:shareId/comments", (c) =>
    handleCreateComment(c.req.raw, c.req.param())
  );
  app.post("/api/cli-login/confirm", (c) => handleConfirmCliLogin(c.req.raw));
  app.patch("/api/comment-threads/:threadId", (c) =>
    handleUpdateCommentThread(c.req.raw, c.req.param())
  );
  app.post("/api/comment-threads/:threadId/replies", (c) =>
    handleCreateCommentReply(c.req.raw, c.req.param())
  );

  app.get("/r/:shareId/:versionNumber", (c) =>
    handleRenderVersion(c.req.raw, c.req.param())
  );
  app.get("/r/:shareId/:versionNumber/assets/*", (c) =>
    handleRenderVersionAsset(c.req.raw, {
      ...c.req.param(),
      assetPath: assetPathOf(c.req.raw.url)
    })
  );
}

/**
 * Everything after `/r/<shareId>/<versionNumber>/assets/`. Hono does not name
 * the wildcard tail, so read it back off the request path.
 */
function assetPathOf(requestUrl: string): string {
  return new URL(requestUrl).pathname.split("/").slice(5).join("/");
}
