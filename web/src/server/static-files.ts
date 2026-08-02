/**
 * Serving the built client.
 *
 * The client directory is resolved from this module, not from the working
 * directory, so the server behaves the same wherever it is started from. The
 * built layout is `dist/server/main.js` next to `dist/client/`.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL("../client", import.meta.url));
const immutableCacheControl = "public, max-age=31536000, immutable";

/**
 * A file from the built client, or null when the path is not one — the caller
 * decides what to do instead. Hashed asset paths are the exception: a miss
 * there is a miss, not a page.
 */
export async function serveStaticAsset(
  pathname: string
): Promise<Response | null> {
  if (pathname === "/" || pathname.endsWith("/")) {
    return null;
  }

  const hashedAsset = pathname.startsWith("/assets/");
  const filePath = join(clientDir, safeDecode(pathname));

  if (!filePath.startsWith(`${clientDir}${sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      return hashedAsset ? notFound() : null;
    }
  } catch {
    return hashedAsset ? notFound() : null;
  }

  const headers = new Headers({
    "Content-Type": contentTypeForPath(filePath)
  });

  if (hashedAsset) {
    headers.set("Cache-Control", immutableCacheControl);
  }

  return new Response(readableStreamOf(filePath), { headers });
}

/** The SPA shell, for every path the client routes itself. */
export async function serveAppShell(): Promise<Response> {
  try {
    const html = await readFile(join(clientDir, "index.html"), "utf8");

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      }
    });
  } catch {
    // Only reachable before `vite build` has run, which is the dev server's
    // job. Answering 404 beats crashing the API server.
    return notFound();
  }
}

function readableStreamOf(filePath: string): ReadableStream<Uint8Array> {
  // Node's stream/web ReadableStream is structurally the same as the DOM one
  // Response takes, but the two type declarations are separate.
  return Readable.toWeb(
    createReadStream(filePath)
  ) as unknown as ReadableStream<Uint8Array>;
}

function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
