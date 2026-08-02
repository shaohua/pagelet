#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import {
  createPageletDraftResponseSchema,
  createVersionDraftResponseSchema,
  finalizeVersionResponseSchema,
  getPublishConfigResponseSchema,
  type CreatePageletDraftRequest,
  type CreateVersionDraftRequest,
  type FinalizeVersionRequest,
  type GetPublishConfigResponse
} from "@pagelet/shared";
import { runAdmin } from "./admin/index.js";
import type { AdminDepsOverrides } from "./admin/deps.js";
import { pollUntilComplete, startCliLogin } from "./cli-login.js";
import { cliConfigPath, readCliConfig, writeCliConfig } from "./config.js";
import { authHeaders, postJson, readJsonResponse } from "./http.js";
import {
  preparePublish,
  type ExternalAssetReference,
  type PreparedPublishFile
} from "./publish-assets.js";
import { cliVersion } from "./version.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function getHelpText(): string {
  return [
    "Pagelet CLI",
    "",
    "Usage:",
    "  pagelet --help",
    "  pagelet --version",
    "  pagelet login",
    "  pagelet publish <file> [--root dir] [--assets glob]",
    "  pagelet feedback [share_id]",
    "  pagelet feedback [share_id] --output pagelet-feedback.md",
    "  pagelet admin setup [--project id] [--region region]",
    "  pagelet admin status",
    "  pagelet admin destroy [--delete-data]",
    "",

    "Environment:",
    "  PAGELET_API_URL   Pagelet web/API base URL",
    "  PAGELET_TOKEN     CLI bearer token for automation"
  ].join("\n");
}

export async function runCli(
  argv: string[],
  deps: AdminDepsOverrides = {}
): Promise<CliResult> {
  const [command] = argv;

  if (!command || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: `${getHelpText()}\n`, stderr: "" };
  }

  if (command === "--version" || command === "-v") {
    return { exitCode: 0, stdout: `${cliVersion()}\n`, stderr: "" };
  }

  if (command === "publish") {
    return publish(argv.slice(1));
  }

  if (command === "login") {
    return login(argv.slice(1));
  }

  if (command === "feedback") {
    return feedback(argv.slice(1));
  }

  if (command === "admin") {
    return runAdmin(argv.slice(1), deps);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `Unknown command: ${command}\n\n${getHelpText()}\n`
  };
}

async function feedback(args: string[]): Promise<CliResult> {
  try {
    const options = await parseFeedbackArgs(args);
    const apiBaseUrl = await getApiBaseUrl();
    const search = new URLSearchParams();

    if (options.version) {
      search.set("version", options.version);
    }

    if (options.status) {
      search.set("status", options.status);
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await fetch(
      `${apiBaseUrl}/api/pagelets/${options.shareId}/feedback.md${suffix}`,
      {
        headers: await authHeaders()
      }
    );
    const markdown = await response.text();

    if (!response.ok) {
      throw new Error(`Feedback request failed: ${response.status} ${markdown}`);
    }

    if (options.output) {
      await writeFile(resolve(options.output), markdown);
      return {
        exitCode: 0,
        stdout: `Wrote feedback to ${options.output}\n`,
        stderr: ""
      };
    }

    return { exitCode: 0, stdout: markdown, stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  }
}

async function login(args: string[]): Promise<CliResult> {
  try {
    const options = parseLoginArgs(args);
    const apiBaseUrl = await getApiBaseUrl();
    const started = await startCliLogin(apiBaseUrl, {
      label: options.label
    });
    const intro = [
      `Open: ${started.verificationUrl}`,
      `Code: ${started.userCode}`
    ];

    if (options.noWait) {
      return {
        exitCode: 0,
        stdout: `${intro.join("\n")}\n`,
        stderr: ""
      };
    }

    const completed = await pollUntilComplete(apiBaseUrl, started);

    if (completed.status !== "complete") {
      throw new Error("CLI login expired before approval");
    }

    await writeCliConfig({
      apiBaseUrl,
      token: completed.token
    });

    return {
      exitCode: 0,
      stdout: `${[
        ...intro,
        `Logged in as ${completed.user.email}`,
        `Saved token to ${cliConfigPath()}`
      ].join("\n")}\n`,
      stderr: ""
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  }
}

/**
 * A compiled binary is always the entry point, but its argv[1] is a virtual
 * bunfs path that realpathSync cannot resolve, so its build injects this
 * constant (bun build --define PAGELET_COMPILED=true).
 */
declare const PAGELET_COMPILED: boolean | undefined;

/**
 * npm invokes bins through a symlink in node_modules/.bin, so argv[1] and
 * import.meta.url only agree after resolving the link. String-building the
 * URL would also break on Windows paths and spaces; pathToFileURL owns that.
 */
function invokedAsBin(): boolean {
  if (typeof PAGELET_COMPILED !== "undefined" && PAGELET_COMPILED) {
    return true;
  }

  const argv1 = process.argv[1];

  if (!argv1) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (invokedAsBin()) {
  runCli(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        error instanceof Error ? `${error.message}\n` : "Unknown CLI error\n"
      );
      process.exitCode = 1;
    });
}

async function publish(args: string[]): Promise<CliResult> {
  try {
    const options = parsePublishArgs(args);
    const htmlPath = resolve(options.file);
    const prepared = await preparePublish(
      htmlPath,
      {
        rootDir: options.root ? resolve(options.root) : undefined,
        explicitAssets: options.assets
      }
    );
    const html = prepared.html.bytes.toString("utf8");
    const title = options.title ?? inferTitle(html) ?? basename(htmlPath, ".html");
    const apiBaseUrl = await getApiBaseUrl();
    const publishConfig = await getPublishConfig(apiBaseUrl);
    const externalReferenceNotice = formatExternalReferenceNotices(
      prepared.externalReferences,
      publishConfig.allowedExternalOrigins
    );
    const bindingPath = join(dirname(htmlPath), ".pagelet.publish.json");
    const binding = options.pagelet
      ? null
      : await readPublishBinding(bindingPath);
    const shareId = options.pagelet ?? binding?.shareId;
    const uploadFiles = [prepared.html, ...prepared.assets];
    const draft = shareId
      ? await createVersionDraft(apiBaseUrl, shareId, {
          message: options.message,
          files: uploadFiles.map((file) => file.draftFile)
        })
      : await createPageletDraft(apiBaseUrl, {
          title,
          message: options.message,
          files: uploadFiles.map((file) => file.draftFile)
        });
    const uploadByOriginalPath = new Map(
      draft.uploadUrls.map((upload) => [upload.originalPath, upload])
    );
    const htmlUpload = uploadByOriginalPath.get(prepared.html.draftFile.originalPath);

    if (!htmlUpload) {
      throw new Error("Publish draft did not include an HTML upload URL");
    }

    for (const file of uploadFiles) {
      const upload = uploadByOriginalPath.get(file.draftFile.originalPath);

      if (!upload) {
        throw new Error(`Publish draft did not include ${file.draftFile.originalPath}`);
      }

      await uploadFile(
        upload.uploadUrl,
        file.bytes,
        file.draftFile.contentType,
        apiBaseUrl
      );
    }

    const finalizeRequest: FinalizeVersionRequest = {
      htmlObject: htmlUpload.gcsObject,
      assetManifest: prepared.assets.map((file) =>
        assetManifestEntry(file, uploadByOriginalPath)
      ),
      sha256: prepared.html.draftFile.sha256,
      sizeBytes: prepared.html.draftFile.sizeBytes
    };
    const finalized = await finalizeVersion(
      apiBaseUrl,
      draft.pagelet.shareId,
      draft.draftId,
      finalizeRequest
    );

    await writeFile(
      bindingPath,
      `${JSON.stringify(
        {
          shareId: finalized.pagelet.shareId,
          title: finalized.pagelet.title,
          lastPublishedVersion: finalized.version.versionNumber
        },
        null,
        2
      )}\n`
    );

    const lines = [
      `Published ${finalized.pagelet.title}`,
      `Version: ${finalized.version.versionNumber}`,
      `URL: ${finalized.url}`
    ];

    if (finalized.version.versionNumber > 1) {
      lines.push(`Version URL: ${finalized.versionUrl}`);
    }

    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: externalReferenceNotice
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  }
}

function assetManifestEntry(
  file: PreparedPublishFile,
  uploadByOriginalPath: Map<string, { gcsObject: string }>
) {
  if (!file.asset) {
    throw new Error("Expected asset manifest entry");
  }

  const upload = uploadByOriginalPath.get(file.draftFile.originalPath);

  if (!upload) {
    throw new Error(`Missing uploaded object for ${file.draftFile.originalPath}`);
  }

  return {
    ...file.asset,
    gcsObject: upload.gcsObject
  };
}

export function formatExternalReferenceNotices(
  references: ExternalAssetReference[],
  allowedExternalOrigins: string[]
): string {
  const allowedOrigins = new Set(allowedExternalOrigins);
  const countsByOrigin = new Map<string, number>();

  for (const reference of references) {
    countsByOrigin.set(
      reference.origin,
      (countsByOrigin.get(reference.origin) ?? 0) + 1
    );
  }

  const lines = [...countsByOrigin.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([origin, count]) => {
      const suffix = count === 1 ? "reference" : "references";

      if (allowedOrigins.has(origin)) {
        return `Notice: external asset origin is allowed by Pagelet CSP: ${origin} (${count} ${suffix})`;
      }

      return `Warning: external asset origin is not allow-listed and will be blocked by Pagelet CSP: ${origin} (${count} ${suffix})`;
    });

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

type PublishOptions = {
  file: string;
  root?: string;
  assets?: string[];
  title?: string;
  pagelet?: string;
  message?: string;
};

type FeedbackOptions = {
  shareId: string;
  version?: string;
  status?: string;
  output?: string;
};

type LoginOptions = {
  label?: string;
  noWait: boolean;
};

function parsePublishArgs(args: string[]): PublishOptions {
  const [file, ...rest] = args;

  if (!file) {
    throw new Error("Usage: pagelet publish <file>");
  }

  const options: PublishOptions = { file };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];

    if (flag === "--title" && value) {
      options.title = value;
      index += 1;
      continue;
    }

    if (flag === "--root" && value) {
      options.root = value;
      index += 1;
      continue;
    }

    if (flag === "--assets" && value) {
      options.assets = [...(options.assets ?? []), value];
      index += 1;
      continue;
    }

    if (flag === "--pagelet" && value) {
      options.pagelet = value;
      index += 1;
      continue;
    }

    if (flag === "--message" && value) {
      options.message = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete publish option: ${flag ?? ""}`);
  }

  return options;
}

function parseLoginArgs(args: string[]): LoginOptions {
  const options: LoginOptions = { noWait: false };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === "--label" && value) {
      options.label = value;
      index += 1;
      continue;
    }

    if (flag === "--no-wait") {
      options.noWait = true;
      continue;
    }

    throw new Error(`Unknown or incomplete login option: ${flag ?? ""}`);
  }

  return options;
}

async function parseFeedbackArgs(args: string[]): Promise<FeedbackOptions> {
  const options: Partial<FeedbackOptions> = {};
  const rest = [...args];

  if (rest[0] && !rest[0].startsWith("--")) {
    options.shareId = rest.shift();
  }

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];

    if (flag === "--version" && value) {
      options.version = value;
      index += 1;
      continue;
    }

    if (flag === "--status" && value) {
      options.status = value;
      index += 1;
      continue;
    }

    if (flag === "--output" && value) {
      options.output = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete feedback option: ${flag ?? ""}`);
  }

  if (!options.shareId) {
    const binding = await readPublishBinding(
      join(process.cwd(), ".pagelet.publish.json")
    );
    options.shareId = binding?.shareId;
  }

  if (!options.shareId) {
    throw new Error("Usage: pagelet feedback [share_id]");
  }

  return options as FeedbackOptions;
}

function inferTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1]?.trim() || null;
}

async function getApiBaseUrl(): Promise<string> {
  return (
    process.env.PAGELET_API_URL ??
    (await readCliConfig())?.apiBaseUrl ??
    "http://127.0.0.1:3000"
  );
}

async function getPublishConfig(
  apiBaseUrl: string
): Promise<GetPublishConfigResponse> {
  const response = await fetch(`${apiBaseUrl}/api/publish-config`, {
    headers: await authHeaders()
  });
  return getPublishConfigResponseSchema.parse(await readJsonResponse(response));
}

async function createPageletDraft(
  apiBaseUrl: string,
  request: CreatePageletDraftRequest
) {
  const response = await postJson(`${apiBaseUrl}/api/pagelets`, request);
  return createPageletDraftResponseSchema.parse(response);
}

async function createVersionDraft(
  apiBaseUrl: string,
  shareId: string,
  request: CreateVersionDraftRequest
) {
  const response = await postJson(
    `${apiBaseUrl}/api/pagelets/${shareId}/versions`,
    request
  );
  return createVersionDraftResponseSchema.parse(response);
}

async function finalizeVersion(
  apiBaseUrl: string,
  shareId: string,
  draftId: string,
  request: FinalizeVersionRequest
) {
  const response = await postJson(
    `${apiBaseUrl}/api/pagelets/${shareId}/versions/${draftId}/finalize`,
    request
  );
  return finalizeVersionResponseSchema.parse(response);
}

async function uploadFile(
  uploadUrl: string,
  body: Buffer,
  contentType: string,
  apiBaseUrl: string
): Promise<void> {
  const headers = isPageletUploadUrl(uploadUrl, apiBaseUrl)
    ? await authHeaders()
    : {};
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...headers
    },
    body: new Blob([new Uint8Array(body)], { type: contentType })
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
}

export function isPageletUploadUrl(uploadUrl: string, apiBaseUrl: string): boolean {
  const upload = new URL(uploadUrl);
  const api = new URL(apiBaseUrl);

  return (
    upload.origin === api.origin &&
    upload.pathname.startsWith("/api/uploads/")
  );
}

type PublishBinding = {
  shareId: string;
  title: string;
  lastPublishedVersion: number;
};

async function readPublishBinding(
  bindingPath: string
): Promise<PublishBinding | null> {
  try {
    return JSON.parse(await readFile(bindingPath, "utf8")) as PublishBinding;
  } catch {
    return null;
  }
}
