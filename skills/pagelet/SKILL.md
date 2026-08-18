---
name: pagelet
description: Publish an HTML report, dashboard, or document for human review, then retrieve anchored comments as Markdown and apply them. Use when the user asks to share a generated page for review or collect feedback from one already published.
---

# Pagelet

Use Pagelet to hand an HTML file to human reviewers and bring their anchored
comments back into the editing workflow.

## Publish

The `pagelet` CLI must be installed. If it is missing, ask the user to install
it with `npm install -g @howtox/pagelet`; do not substitute another workflow.

```sh
pagelet publish report.html
```

The command uploads referenced local assets and prints a `/p/<shareId>` URL.
Give that URL to the user, explain that reviewers comment in the browser, and
stop. Do not fetch the URL or wait for comments in the same turn.

Authentication normally comes from a one-time `pagelet login`. Automation may
instead set `PAGELET_API_URL` and `PAGELET_TOKEN`.

## Collect and apply feedback

When the user says review is complete:

```sh
pagelet feedback report.html
```

A share ID also works if the original file is unavailable. Each item includes
a CSS `Target` (or `whole report`) and may include quoted `Text`.

- `replace`: replace the anchored text with the requested replacement.
- `delete`: remove the anchored content.
- `change_request`: make the described change.
- `question`: answer in chat; do not edit for that item.
- `approve`: leave the content unchanged.
- `note`: context only.

Items are ordered by priority: `blocking`, `high`, then `normal`. Apply every
actionable item, then publish the same file again. Its binding in
`~/.pagelet/pages.json` creates the next version at the same URL.
