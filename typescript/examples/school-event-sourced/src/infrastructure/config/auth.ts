import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import type pg from "pg";

/**
 * better-auth's options, in one place: the service creates better-auth with them, and its
 * migrator plans with them, since the plugins decide the columns. Without a pool, accounts live
 * in memory.
 */
export function authOptions(env: NodeJS.ProcessEnv, pool?: pg.Pool) {
  return {
    baseURL: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`,
    secret: env.AUTH_SECRET ?? "development-only-secret-change-me-0000000000",
    database: pool ?? memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [bearer(), admin()],
  };
}
