import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { DraftUploadFile, VersionAsset } from "@pagelet/shared";

export type PreparedPublishFile = {
  draftFile: DraftUploadFile;
  bytes: Buffer;
  asset?: VersionAsset;
};

export type PreparedPublish = {
  html: PreparedPublishFile;
  assets: PreparedPublishFile[];
  externalReferences: ExternalAssetReference[];
};

export type ExternalAssetReference = {
  url: string;
  origin: string;
};

export type PreparePublishOptions = {
  rootDir?: string;
  explicitAssets?: string[];
};

type AssetRecord = {
  originalPath: string;
  absolutePath: string;
  rewrittenPath: string;
  bytes: Buffer;
  contentType: string;
  sha256: string;
};

const localUrlPattern = /^(?![a-zA-Z][a-zA-Z\d+.-]*:|\/\/|#|data:|blob:|mailto:|tel:)([^?#]+)([?#][^"')\s<>]*)?$/;

export async function preparePublish(
  htmlPath: string,
  optionsOrRootDir: string | PreparePublishOptions = dirname(htmlPath)
): Promise<PreparedPublish> {
  const options = normalizePrepareOptions(htmlPath, optionsOrRootDir);
  const root = await realpath(options.rootDir);
  const entryPath = await assertInsideRoot(htmlPath, root);
  const assets = new Map<string, AssetRecord>();
  const externalReferences = new Map<string, ExternalAssetReference>();
  const htmlSource = await readFile(entryPath, "utf8");
  const html = await rewriteHtml(
    htmlSource,
    entryPath,
    root,
    assets,
    externalReferences
  );
  const htmlBytes = Buffer.from(html);
  const htmlSha = sha256Hex(htmlBytes);

  for (const assetPattern of options.explicitAssets) {
    const assetPaths = await expandExplicitAssetPattern(assetPattern, root);

    for (const assetPath of assetPaths) {
      await addAssetFile(assetPath, root, assets, externalReferences, assetPattern);
    }
  }

  return {
    html: {
      draftFile: {
        role: "html",
        originalPath: relative(root, entryPath) || basename(entryPath),
        rewrittenPath: "report.html",
        contentType: "text/html; charset=utf-8",
        sizeBytes: htmlBytes.byteLength,
        sha256: htmlSha
      },
      bytes: htmlBytes
    },
    assets: [...assets.values()].map((asset) => ({
      draftFile: {
        role: "asset",
        originalPath: asset.originalPath,
        rewrittenPath: asset.rewrittenPath,
        contentType: asset.contentType,
        sizeBytes: asset.bytes.byteLength,
        sha256: asset.sha256
      },
      bytes: asset.bytes,
      asset: {
        originalPath: asset.originalPath,
        rewrittenPath: asset.rewrittenPath,
        gcsObject: "",
        contentType: asset.contentType,
        sizeBytes: asset.bytes.byteLength,
        sha256: asset.sha256
      }
    })),
    externalReferences: [...externalReferences.values()]
  };
}

function normalizePrepareOptions(
  htmlPath: string,
  optionsOrRootDir: string | PreparePublishOptions
): Required<PreparePublishOptions> {
  if (typeof optionsOrRootDir === "string") {
    return {
      rootDir: optionsOrRootDir,
      explicitAssets: []
    };
  }

  return {
    rootDir: optionsOrRootDir.rootDir ?? dirname(htmlPath),
    explicitAssets: optionsOrRootDir.explicitAssets ?? []
  };
}

async function rewriteHtml(
  html: string,
  fromFile: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>
): Promise<string> {
  let output = html;
  output = await replaceAsync(
    output,
    /(<script\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (match) => rewriteHtmlAttribute(match, fromFile, root, assets, externalReferences)
  );
  output = await replaceAsync(
    output,
    /(<link\b(?=[^>]*\brel=["'][^"']*stylesheet[^"']*["'])[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi,
    (match) => rewriteHtmlAttribute(match, fromFile, root, assets, externalReferences)
  );
  output = await replaceAsync(
    output,
    /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (match) => rewriteHtmlAttribute(match, fromFile, root, assets, externalReferences)
  );
  output = await replaceAsync(
    output,
    /(<(?:img|source)\b[^>]*\bsrcset=["'])([^"']+)(["'][^>]*>)/gi,
    async (match) => {
      const prefix = capture(match, 1);
      const value = capture(match, 2);
      const suffix = capture(match, 3);

      return `${prefix}${await rewriteSrcset(
        value,
        fromFile,
        root,
        assets,
        externalReferences
      )}${suffix}`;
    }
  );
  return output;
}

async function rewriteHtmlAttribute(
  match: RegExpExecArray,
  fromFile: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>
): Promise<string> {
  const prefix = capture(match, 1);
  const value = capture(match, 2);
  const suffix = capture(match, 3);

  return `${prefix}${await addAssetReference(
    value,
    fromFile,
    root,
    assets,
    externalReferences
  )}${suffix}`;
}

async function rewriteCss(
  css: string,
  fromFile: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>
): Promise<string> {
  let output = css;
  output = await replaceAsync(
    output,
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    async (match) => {
      const quote = capture(match, 1);
      const value = capture(match, 2);
      const rewritten = toCssAssetPath(
        await addAssetReference(value, fromFile, root, assets, externalReferences)
      );
      return `url(${quote}${rewritten}${quote})`;
    }
  );
  output = await replaceAsync(
    output,
    /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi,
    async (match) => {
      const quote = capture(match, 1);
      const value = capture(match, 2);
      const rewritten = toCssAssetPath(
        await addAssetReference(value, fromFile, root, assets, externalReferences)
      );
      return `@import ${quote}${rewritten}${quote}`;
    }
  );
  return output;
}

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];

  if (value === undefined) {
    throw new Error(`Expected regex capture ${index}`);
  }

  return value;
}

async function rewriteSrcset(
  value: string,
  fromFile: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>
): Promise<string> {
  const candidates = value.split(",");
  const rewritten = await Promise.all(
    candidates.map(async (candidate) => {
      const trimmed = candidate.trim();

      if (!trimmed) {
        return "";
      }

      const [url, ...descriptors] = trimmed.split(/\s+/);

      if (!url) {
        return trimmed;
      }

      const rewrittenUrl = await addAssetReference(
        url,
        fromFile,
        root,
        assets,
        externalReferences
      );
      return [rewrittenUrl, ...descriptors].join(" ");
    })
  );
  return rewritten.join(", ");
}

async function addAssetReference(
  value: string,
  fromFile: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>
): Promise<string> {
  const externalReference = parseExternalUrl(value);

  if (externalReference) {
    externalReferences.set(externalReference.url, externalReference);
    return value;
  }

  const parsed = parseLocalUrl(value);

  if (!parsed) {
    return value;
  }

  const sourcePath = await assertInsideRoot(
    resolveReferencePath(parsed.path, fromFile, root),
    root
  );
  const asset = await addAssetFile(sourcePath, root, assets, externalReferences, value);

  return `${asset.rewrittenPath}${parsed.suffix}`;
}

async function addAssetFile(
  path: string,
  root: string,
  assets: Map<string, AssetRecord>,
  externalReferences: Map<string, ExternalAssetReference>,
  displayPath = path
): Promise<AssetRecord> {
  const sourcePath = await assertInsideRoot(path, root);
  const existing = assets.get(sourcePath);

  if (existing) {
    return existing;
  }

  const stat = await lstat(sourcePath);

  if (!stat.isFile()) {
    throw new Error(`Referenced asset is not a file: ${displayPath}`);
  }

  const rawBytes = await readFile(sourcePath);
  const contentType = contentTypeForPath(sourcePath);
  const bytes =
    contentType === "text/css"
      ? Buffer.from(
          await rewriteCss(
            rawBytes.toString("utf8"),
            sourcePath,
            root,
            assets,
            externalReferences
          )
        )
      : rawBytes;
  const sha256 = sha256Hex(bytes);
  const rewrittenPath = `assets/${sha256}/${basename(sourcePath)}`;
  const originalPath = toPosixPath(relative(root, sourcePath));
  const record = {
    originalPath,
    absolutePath: sourcePath,
    rewrittenPath,
    bytes,
    contentType,
    sha256
  };
  assets.set(sourcePath, record);

  return record;
}

function resolveReferencePath(path: string, fromFile: string, root: string): string {
  return path.startsWith("/") ? resolve(root, `.${path}`) : resolve(dirname(fromFile), path);
}

function parseExternalUrl(value: string): ExternalAssetReference | null {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  try {
    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return {
      url: url.toString(),
      origin: url.origin
    };
  } catch {
    return null;
  }
}

async function expandExplicitAssetPattern(pattern: string, root: string): Promise<string[]> {
  const normalized = normalizeExplicitAssetPattern(pattern);

  if (!normalized) {
    throw new Error("Asset include cannot be empty");
  }

  if (!hasGlobSyntax(normalized)) {
    return [resolve(root, normalized)];
  }

  const matcher = globToRegExp(normalized);
  const files = await listFiles(root);
  const matches = files.filter((file) => matcher.test(toPosixPath(relative(root, file))));

  if (matches.length === 0) {
    throw new Error(`Asset include did not match any files: ${pattern}`);
  }

  return matches;
}

function normalizeExplicitAssetPattern(pattern: string): string {
  const normalized = toPosixPath(pattern.trim()).replace(/^\/+/, "");

  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("Asset include must stay inside publish root");
  }

  return normalized;
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char ?? "");
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function parseLocalUrl(value: string): { path: string; suffix: string } | null {
  const match = localUrlPattern.exec(value.trim());

  if (!match?.[1]) {
    return null;
  }

  return {
    path: decodeURIComponent(match[1]),
    suffix: match[2] ?? ""
  };
}

async function assertInsideRoot(path: string, root: string): Promise<string> {
  const actual = await realpath(path);
  const rel = relative(root, actual);

  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) {
    return actual;
  }

  throw new Error(`Refusing to publish path outside root: ${path}`);
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  let output = "";
  let lastIndex = 0;

  for (const match of matches) {
    output += input.slice(lastIndex, match.index);
    output += await replacer(match);
    lastIndex = match.index + match[0].length;
  }

  output += input.slice(lastIndex);
  return output;
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function toCssAssetPath(rewrittenPath: string): string {
  return rewrittenPath.startsWith("assets/")
    ? `../${rewrittenPath.slice("assets/".length)}`
    : rewrittenPath;
}
