import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the app routes come from the node server on 3001; the public dev URL
// stays http://127.0.0.1:3000.
const appServer = "http://127.0.0.1:3001";

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      "/api": appServer,
      "/auth": appServer,
      "/r": appServer
    }
  },
  build: {
    outDir: "dist/client"
  },
  resolve: {
    tsconfigPaths: true
  },
  plugins: [react()]
});
