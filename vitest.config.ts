import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pagelet/shared": resolve(
        import.meta.dirname,
        "shared/src/index.ts"
      )
    }
  }
});
