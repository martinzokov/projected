import { runMigrations } from "@projected/runtime";
import { migrations } from "./migrations.js";

/**
 * `projected migrate` from the built service — `node .tsbuild/infrastructure/config/migrate.js`,
 * with `--check` to only list what is pending — for a release job whose image carries no
 * development tools.
 */
const { migrators, close } = migrations();
const run = await runMigrations(migrators, { check: process.argv.includes("--check") });
await close();
run.lines.forEach((line) => console.log(line));
process.exitCode = run.ok ? 0 : 1;
