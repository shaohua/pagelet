---
name: pagelet
description: Publish an HTML report, dashboard, or document to a shareable URL for human review, then pull the reviewers' comments back as Markdown and apply them. Use when the user asks to publish or share a report or page for review, get human feedback on work you generated, send something to reviewers, or collect, read, and apply review comments from a published report.
---

# Pagelet

Pagelet publishes an HTML file to a shareable URL where humans comment on the
rendered page, then exports those comments as Markdown carrying a CSS selector
and the exact quote for each item — so the comments can be applied without
reopening the report.

## When to use

The user asks to publish or share a report, dashboard, or document for human
review; asks for feedback from teammates on a page you produced; or asks to
collect and apply reviewer feedback on a report already published.

## Publish

Requires the CLI: `npm install -g @howtox/pagelet`. If `pagelet` is not found,
tell the user to install it instead of working around it.

```sh
pagelet publish report.html
```

It prints the title, the version number, and a `/p/<shareId>` URL. Relative
assets referenced by the HTML (images, CSS) are uploaded with it.

The URL is for the human reviewers, not for you. Give it to the user, say that
reviewers comment on the rendered page in the browser, and stop. Do not fetch
it, and do not wait for comments in the same turn.

Authentication comes from `pagelet login`, run once. In a non-interactive
environment, set `PAGELET_API_URL` and `PAGELET_TOKEN` instead.

## Collect the feedback

Later, when the user says the review is done:

```sh
pagelet feedback <shareId>
```

With no argument, run it from the directory that holds `.pagelet.publish.json`
(written next to the published file) and the share ID is read from there.

## Read the export

Each item carries a `Target` — a CSS selector into the published HTML, or
`whole report` — and, where available, the `Text` it wraps. The selector plus
the quoted text identify the spot to edit. The kind names the edit:

- `replace` — replace the anchored text with the replacement given in the item.
- `delete` — remove the anchored content.
- `change_request` — change the anchored content as the item describes.
- `question` — answer it in chat; do not edit the report for that item.
- `approve` — the anchored content is correct; leave it unchanged.
- `note` — context only; no edit required.

Items are ordered `blocking`, then `high`, then `normal`.

## Publish the next version

After applying the items, publish the same file again. The binding in
`.pagelet.publish.json` makes it version 2 of the same report, and reviewers
see it at the same URL.
