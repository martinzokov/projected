import { defineConfig } from "vitest/config";

// `pnpm load`: the load test alone, at size, with nothing else competing for the machine.
export default defineConfig({ cacheDir: ".vitest-cache", test: { include: ["test/load/run.ts"], testTimeout: 30 * 60_000, reporters: ["verbose"] } });
