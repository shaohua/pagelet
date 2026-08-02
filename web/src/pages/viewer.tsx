import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import type {
  CommentAnchor,
  CommentThreadKind,
  CommentThread,
  GetPageletResponse,
  ListCommentsResponse
} from "@pagelet/shared";
import { reportIframeSandbox } from "../security/render-policy";

type BridgeRect = { x: number; y: number; w: number; h: number };
type HoverRect = BridgeRect & { tagName?: string; selector?: string };

type BridgeMessage = {
  source?: string;
  type?: string;
  rect?: BridgeRect;
  tagName?: string;
  selector?: string;
  anchor?: CommentAnchor;
  requestId?: string;
  results?: { index: number; rect: BridgeRect | null }[];
};

export function PageletViewer({ shareId }: Readonly<{ shareId: string }>) {
  const v = new URLSearchParams(window.location.search).get("v") ?? undefined;
  const versionNumber = v ?? "latest";
  const [pageletData, setPageletData] = useState<GetPageletResponse | null>(
    null
  );
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [commentMode, setCommentMode] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [pendingRect, setPendingRect] = useState<BridgeRect | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentKind, setCommentKind] =
    useState<CommentThreadKind>("change_request");
  // Set when composing feedback about the report as a whole, which has no
  // element to anchor to.
  const [wholeReportComment, setWholeReportComment] = useState(false);
  const [replyTextByThreadId, setReplyTextByThreadId] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [hoverRect, setHoverRect] = useState<HoverRect | null>(null);
  const [resolvedRects, setResolvedRects] = useState<
    Record<string, BridgeRect | null>
  >({});
  const threadsRef = useRef<CommentThread[]>([]);
  const pendingResolveThreads = useRef<CommentThread[]>([]);
  const resolveSeq = useRef(0);
  const pendingResolveId = useRef<string | null>(null);
  const scrollResolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadReviewData = useCallback(async () => {
    const metadataUrl = `/api/pagelets/${shareId}${v ? `?version=${v}` : ""}`;
    const metadata = await fetchJson<GetPageletResponse>(metadataUrl);
    const comments = await fetchJson<ListCommentsResponse>(
      `/api/pagelets/${shareId}/comments?version=${metadata.currentVersion.versionNumber}`
    );

    setPageletData(metadata);
    setThreads(comments.threads);
  }, [shareId, v]);

  useEffect(() => {
    loadReviewData().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "Load failed");
    });
  }, [loadReviewData]);

  async function createThread() {
    const anchored = pendingAnchor && !wholeReportComment;

    if ((!anchored && !wholeReportComment) || !pageletData || !commentText.trim()) {
      return;
    }

    const response = await fetchJson<{ thread: CommentThread }>(
      `/api/pagelets/${shareId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          versionId: pageletData.currentVersion.id,
          kind: commentKind,
          priority: "normal",
          bodyMarkdown: commentText.trim(),
          anchor: wholeReportComment ? null : pendingAnchor
        })
      }
    );

    setThreads((current) => [...current, response.thread]);
    setPendingAnchor(null);
    setPendingRect(null);
    setCommentText("");
    setCommentKind("change_request");
    setWholeReportComment(false);
    setCommentMode(false);
  }

  async function createReply(threadId: string) {
    const bodyMarkdown = replyTextByThreadId[threadId]?.trim();

    if (!bodyMarkdown) {
      return;
    }

    const response = await fetchJson<{ thread: CommentThread }>(
      `/api/comment-threads/${threadId}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ bodyMarkdown })
      }
    );

    setThreads((current) =>
      current.map((thread) =>
        thread.id === response.thread.id ? response.thread : thread
      )
    );
    setReplyTextByThreadId((current) => ({
      ...current,
      [threadId]: ""
    }));
  }

  async function updateThreadStatus(
    threadId: string,
    status: CommentThread["status"]
  ) {
    const response = await fetchJson<{ thread: CommentThread }>(
      `/api/comment-threads/${threadId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status })
      }
    );

    setThreads((current) =>
      current.map((thread) =>
        thread.id === response.thread.id ? response.thread : thread
      )
    );
  }

  const clearResolveRetry = useCallback(() => {
    if (resolveRetry.current) {
      clearTimeout(resolveRetry.current);
      resolveRetry.current = null;
    }
  }, []);

  const clearScrollResolveTimer = useCallback(() => {
    if (scrollResolveTimer.current) {
      clearTimeout(scrollResolveTimer.current);
      scrollResolveTimer.current = null;
    }
  }, []);

  const sendToBridge = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, "*");
  }, []);

  const sendResolve = useCallback(
    (requestId: string, threadsToResolve: CommentThread[]) => {
      sendToBridge({
        type: "pagelet-resolve-all",
        requestId,
        anchors: threadsToResolve.map((thread) => ({
          selector: thread.anchor?.selector
        }))
      });
    },
    [sendToBridge]
  );

  const requestResolveAll = useCallback(
    (threadsToResolve = threadsRef.current) => {
      if (threadsToResolve.length === 0) {
        pendingResolveId.current = null;
        pendingResolveThreads.current = [];
        clearResolveRetry();
        setResolvedRects((current) =>
          Object.keys(current).length === 0 ? current : {}
        );
        return;
      }

      const requestId = String(++resolveSeq.current);
      pendingResolveId.current = requestId;
      pendingResolveThreads.current = threadsToResolve;
      sendResolve(requestId, threadsToResolve);
      // Retry until the bridge acknowledges. The bridge script may not have
      // executed yet when the first message is sent (sandboxed iframe load race),
      // and React may miss the bridge's `ready` postMessage, so we poll.
      clearResolveRetry();
      let attempts = 0;
      const retry = () => {
        if (pendingResolveId.current !== requestId) return; // acknowledged/superseded
        if (attempts++ >= 10) return;
        sendResolve(requestId, threadsToResolve);
        resolveRetry.current = setTimeout(retry, 250);
      };
      resolveRetry.current = setTimeout(retry, 250);
    },
    [clearResolveRetry, sendResolve]
  );

  // Listen for inspector bridge messages from the report iframe.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as BridgeMessage | null;
      if (!data || data.source !== "pagelet-bridge") return;

      if (data.type === "ready") {
        sendToBridge({ type: "pagelet-mode", inspecting: commentMode });
        requestResolveAll();
      } else if (data.type === "hover") {
        if (commentMode && data.rect) {
          setHoverRect({
            x: data.rect.x,
            y: data.rect.y,
            w: data.rect.w,
            h: data.rect.h,
            tagName: data.tagName,
            selector: data.selector
          });
        }
      } else if (data.type === "hover-end") {
        setHoverRect(null);
      } else if (data.type === "select") {
        if (data.anchor) setPendingAnchor(data.anchor);
        setPendingRect(data.rect ?? null);
        setHoverRect(null);
        setCommentMode(false);
      } else if (data.type === "scroll") {
        clearScrollResolveTimer();
        scrollResolveTimer.current = setTimeout(() => requestResolveAll(), 120);
      } else if (data.type === "resolved") {
        if (data.requestId !== pendingResolveId.current) return;
        pendingResolveId.current = null;
        clearResolveRetry();
        const next: Record<string, BridgeRect | null> = {};
        const requestedThreads = pendingResolveThreads.current;
        pendingResolveThreads.current = [];
        const results = data.results ?? [];
        results.forEach((result) => {
          const thread = requestedThreads[result.index];
          if (thread) next[thread.id] = result.rect;
        });
        setResolvedRects(next);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    clearResolveRetry,
    clearScrollResolveTimer,
    commentMode,
    requestResolveAll,
    sendToBridge
  ]);

  // Toggle inspect mode in the bridge.
  useEffect(() => {
    sendToBridge({ type: "pagelet-mode", inspecting: commentMode });
    if (!commentMode) setHoverRect(null);
  }, [commentMode, sendToBridge]);

  // Re-resolve pins whenever threads change. The retry loop inside
  // requestResolveAll handles the sandboxed-iframe load race, so this does not
  // need to wait for the bridge's `ready` message.
  useEffect(() => {
    threadsRef.current = threads;
    requestResolveAll(threads);
  }, [requestResolveAll, threads]);

  useEffect(() => {
    setHoverRect(null);
    setPendingAnchor(null);
    setPendingRect(null);
    setResolvedRects({});
    pendingResolveId.current = null;
    pendingResolveThreads.current = [];
    clearResolveRetry();
    clearScrollResolveTimer();
  }, [clearResolveRetry, clearScrollResolveTimer, shareId, versionNumber]);

  useEffect(
    () => () => {
      clearResolveRetry();
      clearScrollResolveTimer();
    },
    [clearResolveRetry, clearScrollResolveTimer]
  );

  const handleFrameLoad = useCallback(() => {
    setHoverRect(null);
    sendToBridge({ type: "pagelet-mode", inspecting: commentMode });
    requestResolveAll();
  }, [commentMode, requestResolveAll, sendToBridge]);

  function pinStyleFor(thread: CommentThread): CSSProperties {
    const resolved = resolvedRects[thread.id];
    if (resolved) {
      return pinStyleFromRect(resolved);
    }
    return thread.anchor ? fallbackPinStyle(thread.anchor) : {};
  }

  function pendingPinStyle(): CSSProperties {
    if (pendingRect) {
      return pinStyleFromRect(pendingRect);
    }
    return pendingAnchor ? fallbackPinStyle(pendingAnchor) : {};
  }

  function pinStyleFromRect(rect: BridgeRect): CSSProperties {
    return { left: `${rect.x}px`, top: `${rect.y}px` };
  }

  function fallbackPinStyle(anchor: CommentAnchor): CSSProperties {
    if (anchor.selector || anchor.textFingerprint) {
      const x =
        ((anchor.xPct / 100) * anchor.documentWidth - anchor.scrollX) /
        anchor.viewportWidth;
      const y =
        ((anchor.yPct / 100) * anchor.documentHeight - anchor.scrollY) /
        anchor.viewportHeight;

      return {
        left: `${clampPct(x * 100)}%`,
        top: `${clampPct(y * 100)}%`
      };
    }

    return { left: `${anchor.xPct}%`, top: `${anchor.yPct}%` };
  }

  return (
    <main className="viewer-shell">
      <header className="viewer-header">
        <div>
          <p className="product-name">Pagelet</p>
          <h1>Report Viewer</h1>
        </div>
        <div className="viewer-meta">
          <span>{shareId}</span>
          <span>{versionNumber === "latest" ? "latest" : `v${versionNumber}`}</span>
        </div>
      </header>
      <section className="viewer-body">
        <div
          className={`report-stage ${
            commentMode ? "report-stage-inspecting" : ""
          }`}
        >
          <iframe
            ref={iframeRef}
            className="report-frame"
            title={`Pagelet report ${shareId}`}
            sandbox={reportIframeSandbox}
            src={`/r/${shareId}/${versionNumber}`}
            onLoad={handleFrameLoad}
          />
          <div className="comment-capture">
            {commentMode && hoverRect ? (
              <div
                className="inspector-highlight"
                style={{
                  left: `${hoverRect.x}px`,
                  top: `${hoverRect.y}px`,
                  width: `${hoverRect.w}px`,
                  height: `${hoverRect.h}px`
                }}
              >
                {hoverRect.tagName ? (
                  <span className="inspector-label">{hoverRect.tagName}</span>
                ) : null}
              </div>
            ) : null}
            {threads.map((thread, index) => (
              <span
                className={`comment-pin comment-pin-${thread.status}`}
                key={thread.id}
                style={pinStyleFor(thread)}
              >
                {index + 1}
              </span>
            ))}
            {pendingAnchor ? (
              <span
                className="comment-pin comment-pin-pending"
                style={pendingPinStyle()}
              >
                +
              </span>
            ) : null}
          </div>
        </div>
        <aside className="comment-sidebar" aria-label="Comments">
          <div className="comment-sidebar-header">
            <div>
              <h2>Comments</h2>
              <p>
                {pageletData
                  ? `Version ${pageletData.currentVersion.versionNumber}`
                  : "Loading"}
              </p>
            </div>
            <button
              className="comment-mode-button"
              type="button"
              onClick={() => setCommentMode((current) => !current)}
            >
              {commentMode ? "Cancel" : "Comment"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCommentMode(false);
                setPendingAnchor(null);
                setPendingRect(null);
                setWholeReportComment(true);
              }}
            >
              Comment on whole report
            </button>
          </div>

          {pageletData ? (
            <nav className="version-selector" aria-label="Report versions">
              {pageletData.versions.map((version) => (
                <a
                  className={
                    version.id === pageletData.currentVersion.id
                      ? "version-link version-link-active"
                      : "version-link"
                  }
                  href={`/p/${shareId}?v=${version.versionNumber}`}
                  key={version.id}
                >
                  v{version.versionNumber}
                </a>
              ))}
            </nav>
          ) : null}

          {error ? <p className="comment-error">{error}</p> : null}

          {pendingAnchor || wholeReportComment ? (
            <form
              className="comment-composer"
              onSubmit={(event) => {
                event.preventDefault();
                createThread().catch((createError: unknown) => {
                  setError(
                    createError instanceof Error
                      ? createError.message
                      : "Could not create comment"
                  );
                });
              }}
            >
              <label htmlFor="comment-kind">What should change?</label>
              <select
                id="comment-kind"
                value={commentKind}
                onChange={(event) =>
                  setCommentKind(event.currentTarget.value as CommentThreadKind)
                }
              >
                <option value="change_request">Change this</option>
                <option value="replace">Replace with…</option>
                <option value="delete">Delete this</option>
                <option value="question">Question — do not edit</option>
                <option value="approve">Looks good — leave as is</option>
                <option value="note">Note</option>
              </select>

              <label htmlFor="comment-body">
                {wholeReportComment ? "Comment on the whole report" : "New comment"}
              </label>
              <textarea
                id="comment-body"
                value={commentText}
                onChange={(event) => setCommentText(event.currentTarget.value)}
                rows={4}
              />
              <div className="comment-composer-actions">
                <button type="submit">Save</button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingAnchor(null);
                    setPendingRect(null);
                    setWholeReportComment(false);
                    setCommentText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <div className="comment-thread-list">
            {threads.length === 0 ? (
              <p className="comment-empty">No comments yet.</p>
            ) : null}
            {threads.map((thread, index) => (
              <article className="comment-thread" key={thread.id}>
                <div className="comment-thread-title">
                  <span>{index + 1}</span>
                  <strong>{thread.kind.replace("_", " ")}</strong>
                  <em>{thread.status}</em>
                </div>
                <div className="comment-message-list">
                  {thread.messages.map((message) => (
                    <p className="comment-message" key={message.id}>
                      {message.bodyMarkdown}
                    </p>
                  ))}
                </div>
                {thread.status === "open" ? (
                  <form
                    className="comment-reply-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      createReply(thread.id).catch((replyError: unknown) => {
                        setError(
                          replyError instanceof Error
                            ? replyError.message
                            : "Could not add reply"
                        );
                      });
                    }}
                  >
                    <label htmlFor={`reply-${thread.id}`}>Reply</label>
                    <textarea
                      id={`reply-${thread.id}`}
                      rows={3}
                      value={replyTextByThreadId[thread.id] ?? ""}
                      onChange={(event) => {
                        const { value } = event.currentTarget;

                        setReplyTextByThreadId((current) => ({
                          ...current,
                          [thread.id]: value
                        }));
                      }}
                    />
                    <button type="submit">Reply</button>
                  </form>
                ) : null}
                {thread.status === "open" ? (
                  <button
                    type="button"
                    onClick={() => {
                      updateThreadStatus(thread.id, "resolved").catch(
                        (resolveError: unknown) => {
                          setError(
                            resolveError instanceof Error
                              ? resolveError.message
                              : "Could not resolve thread"
                          );
                        }
                      );
                    }}
                  >
                    Resolve
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      updateThreadStatus(thread.id, "open").catch(
                        (reopenError: unknown) => {
                          setError(
                            reopenError instanceof Error
                              ? reopenError.message
                              : "Could not reopen thread"
                          );
                        }
                      );
                    }}
                  >
                    Reopen
                  </button>
                )}
              </article>
            ))}
          </div>

          <p className="viewer-credit">
            Reviewed with{" "}
            <a
              href="https://github.com/shaohua/pagelet"
              target="_blank"
              rel="noreferrer"
            >
              Pagelet
            </a>
          </p>
        </aside>
      </section>
    </main>
  );
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || response.statusText);
  }

  return JSON.parse(text) as T;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}
