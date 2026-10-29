import { describe, expect, it } from "vitest";
import {
  DependencyUnavailable,
  Result,
  aggregateRepository,
  defineAggregate,
  defineEvent,
  z,
  type EventStore,
  type ReadStreamOptions,
  type SnapshotStore,
} from "@projected/application/event-sourced";
import { inMemoryEventStore, inMemorySnapshotStore } from "@projected/store-memory/event-sourced";
import { recordingTelemetry } from "@projected/testing/event-sourced";

const Deposited = defineEvent("Deposited", { schema: z.object({ amount: z.number().int() }) });
const Balance = z.object({ balance: z.number().int(), deposits: z.number().int() });
type Balance = z.infer<typeof Balance>;

const accountWith = (snapshot: { version?: number; every?: number } = {}) =>
  defineAggregate({
    name: "account",
    initialState: (): Balance => ({ balance: 0, deposits: 0 }),
    events: [Deposited],
    evolve: { Deposited: (state, { amount }) => ({ balance: state.balance + amount, deposits: state.deposits + 1 }) },
    snapshot: { schema: Balance, version: snapshot.version ?? 1, every: snapshot.every ?? 3 },
  });

/** An event store that remembers how each stream was read. */
function watchedStore(store: EventStore = inMemoryEventStore()): EventStore & { readonly reads: (ReadStreamOptions | undefined)[] } {
  const reads: (ReadStreamOptions | undefined)[] = [];
  return {
    reads,
    readStream: (stream, options) => {
      reads.push(options);
      return store.readStream(stream, options);
    },
    appendToStream: (stream, events, options) => store.appendToStream(stream, events, options),
    readAll: (options) => store.readAll(options),
  };
}

const deposit = (amount: number, times = 1) => () => Result.ok(Array.from({ length: times }, () => Deposited({ amount })));

const down: SnapshotStore = {
  load: async () => Result.err(new DependencyUnavailable({ dependency: "snapshots", message: "down" })),
  save: async () => Result.err(new DependencyUnavailable({ dependency: "snapshots", message: "down" })),
};

describe("snapshots", () => {
  it("stores the state each time the stream passes another multiple of `every`", async () => {
    const snapshots = inMemorySnapshotStore();
    const accounts = aggregateRepository(accountWith({ every: 3 }), inMemoryEventStore(), { snapshots });

    for (let i = 0; i < 2; i++) await accounts.execute("a-1", deposit(10));
    const beforeThird = (await snapshots.load("account-a-1")).unwrap();
    await accounts.execute("a-1", deposit(10));
    await accounts.execute("a-1", deposit(5, 4));

    expect(beforeThird).toBeUndefined();
    expect((await snapshots.load("account-a-1")).unwrap()).toEqual({ version: 7, schemaVersion: 1, state: { balance: 50, deposits: 7 } });
  });

  it("loads from the latest snapshot and only the events after it", async () => {
    const store = watchedStore();
    const accounts = aggregateRepository(accountWith({ every: 3 }), store, { snapshots: inMemorySnapshotStore() });
    for (let i = 0; i < 4; i++) await accounts.execute("a-1", deposit(10));

    const loaded = (await accounts.load("a-1")).unwrap();

    expect(store.reads.at(-1)).toEqual({ after: 3 });
    expect(loaded).toEqual({ id: "a-1", version: 4, state: { balance: 40, deposits: 4 } });
  });

  it("ignores a snapshot taken under another version of the policy", async () => {
    const snapshots = inMemorySnapshotStore();
    const store = inMemoryEventStore();
    await aggregateRepository(accountWith({ version: 1 }), store, { snapshots }).execute("a-1", deposit(10, 3));
    await snapshots.save("account-a-1", { version: 3, schemaVersion: 1, state: { balance: 999, deposits: 3 } });

    const loaded = (await aggregateRepository(accountWith({ version: 2 }), store, { snapshots }).load("a-1")).unwrap();

    expect(loaded.state).toEqual({ balance: 30, deposits: 3 });
  });

  it("ignores a snapshot that does not match the schema", async () => {
    const snapshots = inMemorySnapshotStore();
    const accounts = aggregateRepository(accountWith(), inMemoryEventStore(), { snapshots });
    await accounts.execute("a-1", deposit(10, 3));
    await snapshots.save("account-a-1", { version: 4, schemaVersion: 1, state: { balance: "lots" } });

    const loaded = (await accounts.load("a-1")).unwrap();

    expect(loaded.state).toEqual({ balance: 30, deposits: 3 });
  });

  it("folds the whole stream when a snapshot is ahead of it", async () => {
    const snapshots = inMemorySnapshotStore();
    const accounts = aggregateRepository(accountWith(), inMemoryEventStore(), { snapshots });
    await snapshots.save("account-a-1", { version: 50, schemaVersion: 1, state: { balance: 500, deposits: 50 } });
    await accounts.execute("a-1", deposit(10, 2));

    const loaded = (await accounts.load("a-1")).unwrap();

    expect(loaded).toEqual({ id: "a-1", version: 2, state: { balance: 20, deposits: 2 } });
  });

  it("carries on from the events alone when the snapshot store is down, counting each failure", async () => {
    const telemetry = recordingTelemetry();
    const accounts = aggregateRepository(accountWith({ every: 2 }), inMemoryEventStore(), { snapshots: down, telemetry });

    const executed = await accounts.execute("a-1", deposit(10, 2));
    const loaded = await accounts.load("a-1");

    expect([executed.isOk(), loaded.unwrap().state]).toEqual([true, { balance: 20, deposits: 2 }]);
    expect([
      telemetry.counted("projected.snapshot.failures", { "projected.step": "load" }),
      telemetry.counted("projected.snapshot.failures", { "projected.step": "save" }),
    ]).toEqual([2, 1]);
  });

  it("reads whole streams when the repository is given no snapshot store", async () => {
    const store = watchedStore();
    const accounts = aggregateRepository(accountWith({ every: 1 }), store);
    await accounts.execute("a-1", deposit(10, 3));

    await accounts.load("a-1");

    expect(store.reads).toEqual([undefined, undefined]);
  });
});
