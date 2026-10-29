import { defineConfig } from "vitest/config";

// The cache stays in the project: mutation sandboxes share node_modules, and must not share a cache.
export default defineConfig({ cacheDir: ".vitest-cache", test: { include: ["test/**/*.test.ts"] } });
