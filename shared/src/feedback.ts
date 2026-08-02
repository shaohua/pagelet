/**
 * Renders review feedback as Markdown for a coding agent.
 *
 * This is the whole point of Pagelet: everything the reviewer did in the
 * browser has to survive as text an agent can act on without opening the
 * report. Two rules follow from that, and both are load-bearing:
 *
 * 1. Emit the CSS selector and the quoted text. A coordinate tells an agent
 *    editing HTML nothing; a selector plus the text it wraps is enough to
 *    find and change the right node.
 * 2. Say each thing once. Per-item boilerplate multiplies by comment count
 *    and lands in the agent's context window, so shared instructions go in
 *    the preamble and the legend covers only the kinds actually present.
 */
import type { CommentThread, CommentThreadKind } from "./schemas.js";

const KIND_LEGEND: Record<CommentThreadKind, string> = {
  change_request: "change the anchored content as the item describes.",
  replace: "replace the anchored text with the replacement given in the item.",
  delete: "remove the anchored content.",
  question: "answer it; do not edit the report for that item.",
  approve: "the anchored content is correct — leave it unchanged.",
  note: "context only; no edit required."
};

const PRIORITY_ORDER = new Map<string, number>([
  ["blocking", 0],
  ["high", 1],
  ["normal", 2]
]);

export interface FeedbackDocument {
  title: string;
  shareId: string;
  versionNumber: number;
  threads: CommentThread[];
}

export function sortFeedbackThreads(threads: CommentThread[]): CommentThread[] {
  return [...threads].sort((a, b) => {
    const priorityDelta =
      (PRIORITY_ORDER.get(a.priority) ?? 99) -
      (PRIORITY_ORDER.get(b.priority) ?? 99);
    return priorityDelta || a.createdAt.localeCompare(b.createdAt);
  });
}

export function renderFeedbackMarkdown({
  title,
  shareId,
  versionNumber,
  threads
}: FeedbackDocument): string {
  const sorted = sortFeedbackThreads(threads);
  const lines = [
    "# Pagelet Feedback",
    "",
    `Report: ${title}`,
    `URL: /p/${shareId}`,
    `Version: ${versionNumber}`,
    ""
  ];

  if (sorted.length === 0) {
    lines.push("No open review items for this version.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Address every item below, then publish a new version of this report.",
    "Anchored items carry a `Target` (a CSS selector into the published HTML)",
    "and, where available, the `Text` it wraps. Items marked `whole report`",
    "are about the document as a whole.",
    ""
  );

  const kindsUsed = [...new Set(sorted.map((thread) => thread.kind))];
  lines.push("Item types used here:", "");
  for (const kind of kindsUsed) {
    lines.push(`- \`${kind}\` — ${KIND_LEGEND[kind]}`);
  }
  lines.push("", "## Items", "");

  for (const [index, thread] of sorted.entries()) {
    lines.push(`### ${index + 1}. [${thread.priority}] ${thread.kind}`);
    lines.push("");

    if (thread.status !== "open") {
      lines.push(`Status: ${thread.status}`);
      lines.push("");
    }

    lines.push(...renderAnchor(thread));

    const [first, ...replies] = thread.messages;

    if (first) {
      lines.push(first.bodyMarkdown.trim(), "");
    }

    for (const reply of replies) {
      lines.push(`Reply: ${reply.bodyMarkdown.trim()}`, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderAnchor(thread: CommentThread): string[] {
  const { anchor } = thread;

  if (!anchor) {
    return ["Target: whole report", ""];
  }

  const lines: string[] = [];

  if (anchor.selector) {
    lines.push(`Target: \`${anchor.selector}\``);
  } else {
    // No selector resolved (e.g. the element was too generic to identify
    // uniquely). Position is a weak fallback, but it beats nothing.
    lines.push(
      `Target: unresolved — near ${anchor.xPct}%, ${anchor.yPct}% of the rendered page`
    );
  }

  if (anchor.quotedText) {
    lines.push(`Text: ${JSON.stringify(anchor.quotedText)}`);
  }

  lines.push("");
  return lines;
}
