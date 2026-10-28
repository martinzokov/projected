import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  Result,
  aggregateRepository,
  catchUp,
  createApplication,
  defineAggregate,
  defineCommand,
  defineContracts,
  defineEvent,
  defineEventHandler,
  z,
  type CommandHandler,
} from "@projected/application/event-sourced";
import {
  checkpointStoreConformance,
  documentStoreConformance,
  eventStoreConformance,
  idempotencyStoreConformance,
  principal,
  sequentialIds,
} from "@projected/testing/event-sourced";
import { fromPool, migrate, postgresReadiness, postgresStores, type SqlClient } from "@projected/store-postgres/event-sourced";
import * as stateBased from "@projected/store-postgres/state-based";
import { stateStoreConformance } from "@projected/testing/state-based";

/**
 * Runs against a real PostgreSQL. Set PROJECTED_TEST_DATABASE_URL to enable, e.g.
 *   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=projected -e POSTGRES_USER=projected postgres:17-alpine
 *   PROJECTED_TEST_DATABASE_URL=postgres://projected:projected@localhost:55432/projected pnpm test
 * Every test gets its own schema.
 */
const url = process.env.PROJECTED_TEST_DATABASE_URL;
const pool = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: 20 });
const schemas: string[] = [];
let counter = 0;

async function freshSchema(migrator: typeof migrate = migrate): Promise<{ sql: SqlClient; schema: string }> {
  if (pool === undefined) throw new Error("PROJECTED_TEST_DATABASE_URL is not set");
  const schema = `projected_test_${process.pid}_${++counter}`;
  schemas.push(schema);
  const sql = fromPool(pool);
  await migrator(sql, { schema });
  return { sql, schema };
}
const stores = async () => {
  const { sql, schema } = await freshSchema();
  return postgresStores(sql, { schema });
};
const stateBasedStores = async () => {
  const { sql, schema } = await freshSchema(stateBased.migrate);
  return stateBased.postgresStores(sql, { schema });
};

afterAll(async () => {
  if (pool === undefined) return;
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

const suite = pool === undefined ? describe.skip : describe;

describe("postgres without a database", () => {
  it("is not ready, and says so within its timeout", async () => {
    const unreachable = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 5_000 });

    const checked = await postgresReadiness(fromPool(unreachable), { timeoutMs: 500 }).check();
    await unreachable.end();

    expect(checked.isErr() && checked.error).toMatchObject({ _tag: "DependencyUnavailable", dependency: "postgres" });
  }, 5_000);
});

suite("postgres", () => {
  it("is ready while the database answers", async () => {
    const checked = await postgresReadiness(fromPool(pool!)).check();

    expect(checked.isOk()).toBe(true);
  });

  eventStoreConformance("postgres", async () => (await stores()).eventStore);
  stateStoreConformance("postgres", async () => (await stateBasedStores()).stateStore);
  checkpointStoreConformance("postgres", async () => (await stores()).checkpoints);
  idempotencyStoreConformance("postgres", async () => (await stores()).idempotency);
  documentStoreConformance("postgres", async () => (await stores()).documents);

  describe("migrations", () => {
    it("are idempotent and safe to run concurrently", async () => {
      const { sql, schema } = await freshSchema();

      const again = await Promise.all([migrate(sql, { schema }), migrate(sql, { schema })]);

      expect(again.map((report) => report.applied)).toEqual([[], []]);
    });

    it("keep each flavour's tables on its own track, so one schema can hold both", async () => {
      const { sql, schema } = await freshSchema();

      const report = await stateBased.migrate(sql, { schema });

      expect(report.applied).toEqual(["state-based@1"]);
      expect(report.current).toEqual({ core: 1, "state-based": 1 });
    });

    it("report missing tables as an unavailable dependency with a hint", async () => {
      const sql = fromPool(pool as pg.Pool);
      const { eventStore } = postgresStores(sql, { schema: "projected_never_migrated" });

      const read = await eventStore.readStream("x-1");

      expect(read.isErr() && read.error.message).toMatch(/run migrate/);
    });
  });

  describe("global ordering", () => {
    it("never lets a catch-up reader skip an event, however appends interleave", async () => {
      const { eventStore } = await stores();
      const seen: number[] = [];
      let position = 0;
      let writing = true;
      const reader = (async () => {
        while (writing || seen.length < 200) {
          const batch = (await eventStore.readAll({ after: position, limit: 50 })).unwrap();
          for (const event of batch) {
            seen.push(event.globalPosition);
            position = event.globalPosition;
          }
        }
      })();

      await Promise.all(
        Array.from({ length: 40 }, (_, stream) =>
          (async () => {
            for (let i = 0; i < 5; i++) {
              (await eventStore.appendToStream(`order-${stream}`, [{ type: "A", schemaVersion: 1, data: { i } }], { expectedVersion: i })).unwrap();
            }
          })(),
        ),
      );
      writing = false;
      await reader;

      const all = (await eventStore.readAll({ after: 0, limit: 1000 })).unwrap().map((event) => event.globalPosition);
      expect(seen).toEqual(all);
    });
  });

  describe("outbox ordering", () => {
    it("never lets a catch-up reader skip an outbox event, however saves interleave", async () => {
      const { stateStore } = await stateBasedStores();
      const seen: number[] = [];
      let position = 0;
      let writing = true;
      const reader = (async () => {
        while (writing || seen.length < 200) {
          const batch = (await stateStore.readAll({ after: position, limit: 50 })).unwrap();
          for (const event of batch) {
            seen.push(event.globalPosition);
            position = event.globalPosition;
          }
        }
      })();

      await Promise.all(
        Array.from({ length: 40 }, (_, stream) =>
          (async () => {
            for (let i = 0; i < 5; i++) {
              const write = { state: { schemaVersion: 1, data: { i } }, events: [{ type: "A", schemaVersion: 1, data: { i } }] };
              (await stateStore.save(`order-${stream}`, write, { expectedVersion: i })).unwrap();
            }
          })(),
        ),
      );
      writing = false;
      await reader;

      const all = (await stateStore.readAll({ after: 0, limit: 1000 })).unwrap().map((event) => event.globalPosition);
      expect(seen).toEqual(all);
    });
  });

  describe("a whole application", () => {
    const Deposited = defineEvent("Deposited", { schema: z.object({ amount: z.number() }) });
    const Account = defineAggregate({
      name: "account",
      initialState: (): number => 0,
      events: [Deposited],
      evolve: { Deposited: (balance, { amount }) => balance + amount },
    });
    const Deposit = defineCommand({
      type: "deposit-money",
      input: z.object({ accountId: z.string(), amount: z.number().positive() }),
      output: z.object({ balance: z.number() }),
    });
    const Balance = z.object({ accountId: z.string(), balance: z.number() });

    it("persists events, projects them and protects against duplicates", async () => {
      const { eventStore, checkpoints, idempotency, documents } = await stores();
      const accounts = aggregateRepository(Account, eventStore);
      const balances = documents.collection("balances", Balance);
      const deposit: CommandHandler<typeof Deposit> = async ({ accountId, amount }, context) =>
        (await accounts.execute(accountId, () => Result.ok([Deposited({ amount })]), context)).map(({ state }) => ({ balance: state }));
      const projection = defineEventHandler({
        name: "balances",
        events: [Deposited],
        handle: {
          Deposited: async ({ stream }) => {
            const accountId = stream.slice("account-".length);
            const loaded = await accounts.load(accountId);
            if (loaded.isErr()) return Result.err(loaded.error);
            return balances.put(accountId, { accountId, balance: loaded.value.state });
          },
        },
      });
      const app = createApplication(defineContracts({ name: "bank", access: "authenticated", commands: [Deposit] }), {
        ids: sequentialIds(),
        commands: { "deposit-money@1": deposit },
        idempotency: { store: idempotency },
        eventHandling: { handlers: [projection], store: eventStore, checkpoints },
      });
      const teller = principal("u-teller");

      await app.execute(Deposit, { accountId: "a-1", amount: 10 }, { principal: teller, idempotencyKey: "dep-1" });
      await app.execute(Deposit, { accountId: "a-1", amount: 10 }, { principal: teller, idempotencyKey: "dep-1" });
      await app.execute(Deposit, { accountId: "a-1", amount: 5 }, { principal: teller, idempotencyKey: "dep-2" });

      expect((await balances.get("a-1")).unwrap()).toEqual({ accountId: "a-1", balance: 15 });
      expect((await eventStore.readStream("account-a-1")).unwrap().events.map((event) => event.metadata.principalId)).toEqual([
        "u-teller",
        "u-teller",
      ]);
      expect((await catchUp(projection, eventStore, checkpoints)).unwrap().handled).toBe(0);
    });
  });
});
