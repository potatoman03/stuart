import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/._*"]
  },
  resolve: {
    alias: {
      "@stuart/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@stuart/db": resolve(__dirname, "packages/db/src/index.ts"),
      "@stuart/runtime-supervisor": resolve(__dirname, "packages/runtime-supervisor/src/index.ts"),
      "@stuart/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts")
    }
  }
});
