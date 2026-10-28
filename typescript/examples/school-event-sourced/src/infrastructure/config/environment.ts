import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore } from "@projected/store-memory/event-sourced";
import { fromPool, postgresReadiness, postgresStores } from "@projected/store-postgres/event-sourced";
import { eventRelay, transportReadiness, type MessageTransport } from "@projected/messaging";
import { kafkaTransport } from "@projected/kafka";
import { natsTransport } from "@projected/nats";
import { prepareSchema } from "@projected/runtime";
import { betterAuth } from "better-auth";
import pg from "pg";
import type { Clock, ReadinessCheck } from "@projected/application/event-sourced";
import { authOptions } from "./auth.js";
import { migrators } from "./migrations.js";

/**
 * Picks real infrastructure from the environment, and in-memory stand-ins otherwise, so the
 * service runs with `pnpm start` alone and against Postgres, Kafka or NATS when configured:
 *
 *   DATABASE_URL      PostgreSQL for events, checkpoints, idempotency, read models and better-auth
 *   KAFKA_BROKERS     publish school events to the `school.events` Kafka topic
 *   NATS_URL          publish school events to the `school.events` JetStream subject
 *   AUTH_SECRET       better-auth's secret (required outside development)
 *   MIGRATE_ON_START  "false" where `projected migrate` runs before each rollout: the service
 *                     then only checks that its tables are current, and refuses to start if not
 */
export async function environment(clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL });
  const db = pool === undefined ? undefined : fromPool(pool);
  if (pool !== undefined) {
    // Before anything uses them: better-auth checks its tables when it is created.
    const schema = await prepareSchema(migrators(pool, env), { apply: env.MIGRATE_ON_START !== "false" });
    if (schema.isErr()) throw schema.error;
  }
  const stores =
    db === undefined
      ? {
          eventStore: inMemoryEventStore({ clock }),
          checkpoints: inMemoryCheckpointStore(),
          idempotency: inMemoryIdempotencyStore({ clock }),
          documents: inMemoryDocumentStore(),
        }
      : postgresStores(db);
  const auth = betterAuth(authOptions(env, pool));

  const transports: Array<{ name: string; transport: MessageTransport & { close(): Promise<void> } }> = [];
  if (env.KAFKA_BROKERS !== undefined) transports.push({ name: "kafka", transport: kafkaTransport({ brokers: env.KAFKA_BROKERS.split(","), clientId: "school" }) });
  if (env.NATS_URL !== undefined) transports.push({ name: "nats", transport: natsTransport({ servers: env.NATS_URL }) });
  const relays = transports.map(({ transport }, index) => eventRelay(transport, { name: `school-events-${index + 1}`, topic: "school.events" }));
  // Not ready while the database or a broker the events go to is unreachable.
  const readiness: ReadinessCheck[] = [
    ...(db === undefined ? [] : [postgresReadiness(db)]),
    ...transports.map(({ name, transport }) => transportReadiness(name, transport)),
  ];

  return {
    ...stores,
    auth,
    eventHandlers: relays,
    readiness,
    close: async () => {
      await Promise.all(transports.map(({ transport }) => transport.close()));
      await pool?.end();
    },
  };
}
