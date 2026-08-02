import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const baseUrl = process.env.PAGELET_DEPLOYED_URL ?? process.env.APP_BASE_URL;
const token = process.env.PAGELET_TOKEN ?? process.env.PAGELET_DEV_TOKEN;

if (!baseUrl) {
  throw new Error("Set PAGELET_DEPLOYED_URL or APP_BASE_URL before running smoke:deployed");
}

if (!token) {
  throw new Error(
    "Set PAGELET_TOKEN or PAGELET_DEV_TOKEN before running authenticated smoke:deployed"
  );
}

const origin = new URL(baseUrl);
const apiUrl = origin.origin;
const reportDir = await mkdtemp(resolve(tmpdir(), "pagelet-deployed-reports-"));
const cliPath = resolve(root, "cli/dist/index.js");

await execFileAsync("npm", ["run", "build", "-w", "cli"], {
  cwd: root
});
await cp(resolve(root, "demo/reports"), reportDir, { recursive: true });
await rm(resolve(reportDir, ".pagelet.publish.json"), { force: true });

try {
  await assertText(new URL("/", origin), "Pagelet", { auth: false });
  const publishConfig = await fetchJson(new URL("/api/publish-config", origin), {
    auth: false
  });

  if (!Number.isInteger(publishConfig.maxUploadBytes)) {
    throw new Error("Publish config did not include maxUploadBytes");
  }

  if (!Array.isArray(publishConfig.allowedExternalOrigins)) {
    throw new Error("Publish config did not include allowedExternalOrigins");
  }

  const v1 = await runCli(["publish", resolve(reportDir, "dashboard-v1.html")]);
  assertIncludes(v1.stdout, "Version: 1", "first publish version");
  const pageletUrl = parsePublishedUrl(v1.stdout);
  const shareId = parseShareId(pageletUrl);

  await assertText(pageletUrl, "Report Viewer", { auth: true });

  const renderedV1 = await fetchText(
    new URL(`/r/${shareId}/latest`, origin),
    { auth: true }
  );
  assertIncludes(renderedV1, "ARR by Month", "v1 rendered report");
  assertIncludes(renderedV1, "<base", "rendered base tag");
  assertDoesNotInclude(
    renderedV1,
    "storage.googleapis.com",
    "rendered report permanent GCS URL"
  );

  const assetMatch = /src="(assets\/[^"]+chart\.svg)"/.exec(renderedV1);

  if (!assetMatch?.[1]) {
    throw new Error("Rendered report did not include rewritten chart asset");
  }

  const chartAsset = await fetchText(
    new URL(`/r/${shareId}/1/${assetMatch[1]}`, origin),
    { auth: true }
  );
  assertIncludes(chartAsset, "<svg", "served chart asset");

  const metadata = await fetchJson(new URL(`/api/pagelets/${shareId}`, origin), {
    auth: true
  });
  const createdThread = await fetchJson(
    new URL(`/api/pagelets/${shareId}/comments`, origin),
    {
      auth: true,
      method: "POST",
      body: JSON.stringify({
        versionId: metadata.currentVersion.id,
        kind: "question",
        priority: "normal",
        bodyMarkdown: "Can we break this out by region?",
        anchor: {
          xPct: 42,
          yPct: 32,
          documentWidth: 960,
          documentHeight: 720,
          viewportWidth: 1280,
          viewportHeight: 800,
          scrollX: 0,
          scrollY: 0,
          textFingerprint: "ARR by Month"
        }
      })
    }
  );

  const comments = await fetchJson(
    new URL(`/api/pagelets/${shareId}/comments?version=1`, origin),
    { auth: true }
  );
  assertIncludes(
    JSON.stringify(comments),
    "Can we break this out by region?",
    "comment list"
  );

  await fetchJson(
    new URL(`/api/comment-threads/${createdThread.thread.id}/replies`, origin),
    {
      auth: true,
      method: "POST",
      body: JSON.stringify({
        bodyMarkdown: "Yes, please split it into Americas, EMEA, and APAC."
      })
    }
  );
  const commentsWithReply = await fetchJson(
    new URL(`/api/pagelets/${shareId}/comments?version=1`, origin),
    { auth: true }
  );
  assertIncludes(
    JSON.stringify(commentsWithReply),
    "Americas, EMEA, and APAC",
    "comment reply list"
  );

  const feedback = await runCli(["feedback", shareId]);
  assertIncludes(feedback.stdout, "# Pagelet Feedback", "feedback heading");
  assertIncludes(
    feedback.stdout,
    "Can we break this out by region?",
    "feedback comment"
  );
  assertIncludes(feedback.stdout, "Americas, EMEA, and APAC", "feedback reply");

  const resolvedThread = await fetchJson(
    new URL(`/api/comment-threads/${createdThread.thread.id}`, origin),
    {
      auth: true,
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" })
    }
  );

  if (resolvedThread.thread.status !== "resolved") {
    throw new Error("Thread did not resolve");
  }

  const v2 = await runCli([
    "publish",
    resolve(reportDir, "dashboard-v2.html"),
    "--message",
    "Address deployed smoke review comments"
  ]);
  assertIncludes(v2.stdout, "Version: 2", "second publish version");

  const renderedLatest = await fetchText(
    new URL(`/r/${shareId}/latest`, origin),
    { auth: true }
  );
  assertIncludes(renderedLatest, "Regional Breakdown", "v2 rendered report");

  const renderedHistorical = await fetchText(
    new URL(`/r/${shareId}/1`, origin),
    { auth: true }
  );
  assertIncludes(renderedHistorical, "ARR by Month", "historical v1 report");

  console.log("Authenticated deployed smoke passed");
} finally {
  await rm(reportDir, { force: true, recursive: true });
}

async function runCli(args) {
  return execFileAsync("node", [cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PAGELET_API_URL: apiUrl,
      PAGELET_TOKEN: token
    }
  });
}

async function assertText(url, expected, options) {
  const text = await fetchText(url, options);

  if (!text.includes(expected)) {
    throw new Error(`${url} did not include ${expected}`);
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: requestHeaders(options)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}\n${text}`);
  }

  return text;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: requestHeaders(init)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}\n${text}`);
  }

  return JSON.parse(text);
}

function requestHeaders(options) {
  return {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.auth ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {})
  };
}

function parsePublishedUrl(stdout) {
  const urlMatch = /^URL: (.+)$/m.exec(stdout);

  if (!urlMatch?.[1]) {
    throw new Error(`Could not find published URL in CLI output:\n${stdout}`);
  }

  return new URL(urlMatch[1]);
}

function parseShareId(pageletUrl) {
  const shareId = pageletUrl.pathname.split("/").filter(Boolean).pop();

  if (!shareId) {
    throw new Error(`Could not parse share id from ${pageletUrl.toString()}`);
  }

  return shareId;
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${expected}`);
  }
}

function assertDoesNotInclude(value, expected, label) {
  if (value.includes(expected)) {
    throw new Error(`${label} unexpectedly included ${expected}`);
  }
}
