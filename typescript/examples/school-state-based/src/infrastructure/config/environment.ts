import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryIdempotencyStore, inMemoryStateStore } from "@projected/store-memory/state-based";
import { fromPool, migrate, postgresStores } from "@projected/store-postgres/state-based";
import { eventRelay, type MessageTransport } from "@projected/messaging";
import { kafkaTransport } from "@projected/kafka";
import { natsTransport } from "@projected/nats";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer } from "better-auth/plugins";
import pg from "pg";
import type { Clock } from "@projected/application/state-based";

/**
 * Picks real infrastructure from the environment, and in-memory stand-ins otherwise, so the
 * service runs with `pnpm start` alone and against Postgres, Kafka or NATS when configured:
 *
 *   DATABASE_URL   PostgreSQL for students and their outbox, checkpoints, idempotency, read models and better-auth
 *   KAFKA_BROKERS  publish school events to the `school.events` Kafka topic
 *   NATS_URL       publish school events to the `school.events` JetStream subject
 *   AUTH_SECRET    better-auth's secret (required outside development)
 */
export async function environment(clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL });
  const stores = await (async () => {
    if (pool === undefined) {
      return {
        stateStore: inMemoryStateStore({ clock }),
        checkpoints: inMemoryCheckpointStore(),
        idempotency: inMemoryIdempotencyStore({ clock }),
        documents: inMemoryDocumentStore(),
      };
    }
    const sql = fromPool(pool);
    await migrate(sql);
    return postgresStores(sql);
  })();

  const authOptions = {
    baseURL: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`,
    secret: env.AUTH_SECRET ?? "development-only-secret-change-me-0000000000",
    database: pool ?? memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [bearer(), admin()],
  };
  // better-auth checks its tables when it is created, so they must exist first.
  if (pool !== undefined) await (await getMigrations(authOptions)).runMigrations();
  const auth = betterAuth(authOptions);

  const transports: Array<MessageTransport & { close(): Promise<void> }> = [];
  if (env.KAFKA_BROKERS !== undefined) transports.push(kafkaTransport({ brokers: env.KAFKA_BROKERS.split(","), clientId: "school" }));
  if (env.NATS_URL !== undefined) transports.push(natsTransport({ servers: env.NATS_URL }));
  const relays = transports.map((transport, index) => eventRelay(transport, { name: `school-events-${index + 1}`, topic: "school.events" }));

  return {
    ...stores,
    auth,
    eventHandlers: relays,
    close: async () => {
      await Promise.all(transports.map((transport) => transport.close()));
      await pool?.end();
    },
  };
}
