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
import { fromPool, postgresMigrator, postgresReadiness, postgresStores, schemaMigrator, type PostgresClient } from "@projected/store-postgres/event-sourced";
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

/** A schema of its own, with no tables yet. */
function emptySchema(): { db: PostgresClient; schema: string } {
  if (pool === undefined) throw new Error("PROJECTED_TEST_DATABASE_URL is not set");
  const schema = `projected_test_${process.pid}_${++counter}`;
  schemas.push(schema);
  return { db: fromPool(pool), schema };
}

async function freshSchema(migrator: typeof postgresMigrator = postgresMigrator): Promise<{ db: PostgresClient; schema: string }> {
  const { db, schema } = emptySchema();
  (await migrator(db, { schema }).apply()).unwrap();
  return { db, schema };
}
const stores = async () => {
  const { db, schema } = await freshSchema();
  return postgresStores(db, { schema });
};
const stateBasedStores = async () => {
  const { db, schema } = await freshSchema(stateBased.postgresMigrator);
  return stateBased.postgresStores(db, { schema });
};

afterAll(async () => {
  if (pool === undefined) return;
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

const suite = pool === undefined ? describe.skip : describe;

describe("postgres without a database", () => {
  it("reports migrations against an unreachable database as unavailable, never throwing", async () => {
    const unreachable = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 2_000 });

    const pending = await postgresMigrator(fromPool(unreachable)).pending();
    await unreachable.end();

    expect(pending.isErr() && pending.error).toMatchObject({ _tag: "DependencyUnavailable", dependency: "postgres projected tables" });
  });

  it("keeps projected's migration tracks to projected", () => {
    const db = fromPool(new pg.Pool());

    expect(() => schemaMigrator(db, { name: "billing", tracks: { core: [] } })).toThrow(/track "core" is projected's own/);
  });

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
    it("list what is pending without changing anything, then nothing once applied", async () => {
      const { db, schema } = emptySchema();
      const migrator = stateBased.postgresMigrator(db, { schema });

      const before = (await migrator.pending()).unwrap();
      const created = await pool!.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]);
      (await migrator.apply()).unwrap();
      const after = (await migrator.pending()).unwrap();

      expect(before).toEqual(["core@1", "state-based@1"]);
      expect(created.rowCount).toBe(0);
      expect(after).toEqual([]);
    });

    it("apply each migration exactly once, however many processes migrate at the same time", async () => {
      const { db, schema } = emptySchema();

      const runs = await Promise.all([1, 2, 3].map(() => postgresMigrator(db, { schema }).apply()));

      expect(runs.flatMap((run) => run.unwrap()).sort()).toEqual(["core@1", "event-sourced@1"]);
    });

    it("keep each flavour's tables on its own track, so one schema can hold both", async () => {
      const { db, schema } = await freshSchema();

      const applied = await stateBased.postgresMigrator(db, { schema }).apply();

      expect(applied.unwrap()).toEqual(["state-based@1"]);
    });

    it("give a service's own tables a track of their own in the same schema", async () => {
      const { db, schema } = await freshSchema();
      const invoices = schemaMigrator(db, {
        name: "billing",
        schema,
        tracks: { invoices: [{ version: 1, up: (scoped) => scoped.schema.createTable("invoices").addColumn("id", "text", (c) => c.primaryKey()).execute() }] },
      });

      const applied = await invoices.apply();
      const table = await pool!.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'invoices'", [schema]);

      expect(applied.unwrap()).toEqual(["invoices@1"]);
      expect(table.rowCount).toBe(1);
      expect((await postgresMigrator(db, { schema }).pending()).unwrap()).toEqual([]);
    });

    it("report missing tables as an unavailable dependency that names the command to run", async () => {
      const { eventStore } = postgresStores(fromPool(pool as pg.Pool), { schema: "projected_never_migrated" });

      const read = await eventStore.readStream("x-1");

      expect(read.isErr() && read.error.message).toMatch(/run `projected migrate`/);
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
