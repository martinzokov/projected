import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = fileURLToPath(new URL("./packages/", import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against package sources, so `pnpm test` needs no build step.
    alias: [
      { find: /^@projected\/([a-z-]+)$/, replacement: `${packages}$1/src/index.ts` },
      // Flavour entry points are directories: `@projected/domain/event-sourced` → src/event-sourced/index.ts.
      { find: /^@projected\/([a-z-]+)\/(event-sourced|state-based)$/, replacement: `${packages}$1/src/$2/index.ts` },
      { find: /^@projected\/([a-z-]+)\/([a-z-]+)$/, replacement: `${packages}$1/src/$2.ts` },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
  },
});
