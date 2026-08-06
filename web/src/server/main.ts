/**
 * The production entry point: one node server in front of the built client and
 * the app routes.
 */
import { serve } from "@hono/node-server";
import { createApp, type PageletSurface } from "./app";
import { serveAppShell, serveStaticAsset } from "./static-files";

const surface = readSurface();
const app = createApp({ surface });
const port = Number(process.env.PORT ?? 3000);
// Paths the server answers. Anything else is a client route.
const serverPathPrefixes = ["/api", "/health", "/r"];

serve({ fetch: handleRequest, hostname: "0.0.0.0", port }, () => {
  console.log(`Pagelet web server listening on ${port}`);
});

async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (surface === "creator" && !isServerPath(pathname)) {
    return new Response("Not found", { status: 404 });
  }

  const asset = await serveStaticAsset(pathname);

  if (asset) {
    return asset;
  }

  if (isServerPath(pathname)) {
    return app.fetch(request);
  }

  return serveAppShell();
}

function readSurface(): PageletSurface {
  const configured = process.env.PAGELET_SURFACE?.trim();

  if (configured === "viewer" || configured === "creator" || configured === "all") {
    return configured;
  }

  return process.env.NODE_ENV === "production" ? "viewer" : "all";
}

function isServerPath(pathname: string): boolean {
  return serverPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
