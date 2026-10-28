import type { ReadinessCheck } from "@projected/application";
import { sql } from "kysely";
import { attempt, type PostgresClient } from "./sql.js";

export interface PostgresReadinessOptions {
  /** Names the database in the health report. Defaults to `postgres`. */
  readonly name?: string;
  /** How long the check waits for an answer. Defaults to 2 s. */
  readonly timeoutMs?: number;
}

/**
 * The database as a readiness check: `SELECT 1`, unavailable when it fails or does not answer in
 * time. A pool waiting for a connection would otherwise hold the probe as long as it likes.
 */
export function postgresReadiness(db: PostgresClient, options: PostgresReadinessOptions = {}): ReadinessCheck {
  const name = options.name ?? "postgres";
  const timeoutMs = options.timeoutMs ?? 2000;
  return {
    name,
    check: () =>
      attempt(name, async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        });
        try {
          await Promise.race([sql`SELECT 1`.execute(db), timeout]);
        } finally {
          clearTimeout(timer);
        }
      }),
  };
}
