import { describe, expect, it } from "vitest";
import { renderFeedbackMarkdown, sortFeedbackThreads } from "./feedback.js";
import type { CommentThread } from "./schemas.js";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageletId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    authorUserId: "44444444-4444-4444-8444-444444444444",
    kind: "change_request",
    priority: "normal",
    status: "open",
    assigneeUserId: null,
    anchor: {
      xPct: 12.5,
      yPct: 40,
      documentWidth: 1200,
      documentHeight: 3000,
      viewportWidth: 1200,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      selector: "main > section:nth-of-type(2) > p",
      textFingerprint: "31:1a2f9c3b",
      quotedText: "Revenue grew 12% year over year."
    },
    messages: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        threadId: "11111111-1111-4111-8111-111111111111",
        authorUserId: "44444444-4444-4444-8444-444444444444",
        bodyMarkdown: "This contradicts the summary table.",
        mentionedUserIds: [],
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:00.000Z",
        editedAt: null
      }
    ],
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides
  };
}

const document = {
  title: "Q3 Report",
  shareId: "abc123",
  versionNumber: 4
};

describe("renderFeedbackMarkdown", () => {
  it("gives the agent a selector and the quoted text, not a coordinate", () => {
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [thread()]
    });

    expect(markdown).toContain("Target: `main > section:nth-of-type(2) > p`");
    expect(markdown).toContain('Text: "Revenue grew 12% year over year."');
    expect(markdown).not.toContain("1a2f9c3b");
    expect(markdown).not.toContain("12.5%");
  });

  it("falls back to position only when no selector resolved", () => {
    const anchored = thread().anchor!;
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [thread({ anchor: { ...anchored, selector: undefined } })]
    });

    expect(markdown).toContain("Target: unresolved — near 12.5%, 40%");
  });

  it("marks a comment on the whole report rather than inventing a target", () => {
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [thread({ anchor: null })]
    });

    expect(markdown).toContain("Target: whole report");
    expect(markdown).not.toContain("unresolved");
  });

  it("states shared instructions once, not per item", () => {
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [thread(), thread({ id: "66666666-6666-4666-8666-666666666666" })]
    });

    const occurrences = markdown.split("then publish a new version").length - 1;
    expect(occurrences).toBe(1);
  });

  it("explains only the kinds actually present", () => {
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [thread({ kind: "question" })]
    });

    expect(markdown).toContain("`question` — answer it");
    expect(markdown).not.toContain("`delete`");
    expect(markdown).not.toContain("`approve`");
  });

  it("orders blocking items first, then by creation time", () => {
    const ordered = sortFeedbackThreads([
      thread({ id: "a", priority: "normal", createdAt: "2026-07-01T09:00:00.000Z" }),
      thread({ id: "b", priority: "blocking", createdAt: "2026-07-01T11:00:00.000Z" }),
      thread({ id: "c", priority: "high", createdAt: "2026-07-01T08:00:00.000Z" })
    ]);

    expect(ordered.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("renders replies under their thread", () => {
    const base = thread();
    const markdown = renderFeedbackMarkdown({
      ...document,
      threads: [
        thread({
          messages: [
            base.messages[0]!,
            { ...base.messages[0]!, id: "77777777-7777-4777-8777-777777777777", bodyMarkdown: "Agreed, use 9%." }
          ]
        })
      ]
    });

    expect(markdown).toContain("Reply: Agreed, use 9%.");
  });

  it("says so plainly when there is nothing to act on", () => {
    const markdown = renderFeedbackMarkdown({ ...document, threads: [] });

    expect(markdown).toContain("No open review items for this version.");
    expect(markdown).not.toContain("## Items");
  });
});
