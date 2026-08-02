/**
 * The production entry point: one node server in front of the built client and
 * the app routes.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { serveAppShell, serveStaticAsset } from "./static-files";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
// Paths the server answers. Anything else is a client route.
const serverPathPrefixes = ["/api", "/auth", "/r"];

serve({ fetch: handleRequest, hostname: "0.0.0.0", port }, () => {
  console.log(`Pagelet web server listening on ${port}`);
});

async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const asset = await serveStaticAsset(pathname);

  if (asset) {
    return asset;
  }

  if (isServerPath(pathname)) {
    return app.fetch(request);
  }

  return serveAppShell();
}

function isServerPath(pathname: string): boolean {
  return serverPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
