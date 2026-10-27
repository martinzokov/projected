import {
  DependencyFailure,
  z,
  type CheckpointStore,
  type DocumentStore,
  type IdempotencyStore,
  type OperationResult,
} from "@projected/application";
import { describe, expect, it } from "vitest";

/**
 * Conformance suites for the storage ports. Every adapter — Postgres today; Mongo, Redis,
 * KurrentDB or Convex tomorrow — runs the suites for the ports it implements. `create` must
 * return an empty store each time.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function checkpointStoreConformance(name: string, create: () => CheckpointStore | Promise<CheckpointStore>): void {
  describe(`CheckpointStore conformance: ${name}`, () => {
    it("starts every handler at position 0", async () => {
      const store = await create();

      expect((await store.load("never-ran")).unwrap()).toBe(0);
    });

    it("remembers the latest saved position", async () => {
      const store = await create();
      await store.save("projection", 5);
      await store.save("projection", 9);

      expect((await store.load("projection")).unwrap()).toBe(9);
    });

    it("keeps handlers independent", async () => {
      const store = await create();
      await store.save("a", 3);

      expect((await store.load("b")).unwrap()).toBe(0);
    });

    it("stores positions beyond 32 bits", async () => {
      const store = await create();
      await store.save("projection", 2 ** 40 + 1);

      expect((await store.load("projection")).unwrap()).toBe(2 ** 40 + 1);
    });
  });
}

const ok = (value: unknown): OperationResult => ({ status: "ok", value });
const window = { lockMs: 60_000, ttlMs: 60_000 };

export function idempotencyStoreConformance(name: string, create: () => IdempotencyStore | Promise<IdempotencyStore>): void {
  describe(`IdempotencyStore conformance: ${name}`, () => {
    it("lets the first request claim a key", async () => {
      const store = await create();

      expect((await store.claim("k", "f-1", window)).unwrap()).toEqual({ status: "claimed" });
    });

    it("reports a claimed key as in progress, with its fingerprint", async () => {
      const store = await create();
      await store.claim("k", "f-1", window);

      expect((await store.claim("k", "f-1", window)).unwrap()).toEqual({ status: "in-progress", fingerprint: "f-1" });
    });

    it("replays the outcome of a completed key", async () => {
      const store = await create();
      await store.claim("k", "f-1", window);
      await store.complete("k", ok({ studentId: "s-1" }));

      expect((await store.claim("k", "f-2", window)).unwrap()).toEqual({
        status: "completed",
        fingerprint: "f-1",
        result: ok({ studentId: "s-1" }),
      });
    });

    it("keeps business errors as outcomes too", async () => {
      const store = await create();
      const rejected: OperationResult = { status: "error", error: { type: "Full", message: "full", data: { capacity: 1 } } };
      await store.claim("k", "f-1", window);
      await store.complete("k", rejected);

      expect((await store.claim("k", "f-1", window)).unwrap()).toMatchObject({ status: "completed", result: rejected });
    });

    it("frees a released key for the next request", async () => {
      const store = await create();
      await store.claim("k", "f-1", window);
      await store.release("k");

      expect((await store.claim("k", "f-1", window)).unwrap()).toEqual({ status: "claimed" });
    });

    it("lets a request take over a claim whose lock expired", async () => {
      const store = await create();
      await store.claim("k", "f-1", { lockMs: 30, ttlMs: 60_000 });
      await sleep(80);

      expect((await store.claim("k", "f-1", window)).unwrap()).toEqual({ status: "claimed" });
    });

    it("forgets completed keys after their time to live", async () => {
      const store = await create();
      await store.claim("k", "f-1", { lockMs: 30, ttlMs: 30 });
      await store.complete("k", ok(1));
      await sleep(80);

      expect((await store.claim("k", "f-1", window)).unwrap()).toEqual({ status: "claimed" });
    });

    it("grants exactly one of many concurrent claims", async () => {
      const store = await create();

      const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim("k", "f-1", window)));

      expect(claims.filter((claim) => claim.unwrap().status === "claimed")).toHaveLength(1);
    });

    it("keeps keys independent", async () => {
      const store = await create();
      await store.claim("a", "f-1", window);

      expect((await store.claim("b", "f-1", window)).unwrap()).toEqual({ status: "claimed" });
    });
  });
}

const Entry = z.object({ id: z.string(), grade: z.number(), house: z.string(), active: z.boolean(), nickname: z.string().nullable() });
type Entry = z.output<typeof Entry>;
const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
  id,
  grade: 1,
  house: "red",
  active: true,
  nickname: null,
  ...overrides,
});

export function documentStoreConformance(name: string, create: () => DocumentStore | Promise<DocumentStore>): void {
  describe(`DocumentStore conformance: ${name}`, () => {
    it("reads a missing document as undefined", async () => {
      const students = (await create()).collection("students", Entry);

      expect((await students.get("nobody")).unwrap()).toBeUndefined();
    });

    it("stores, replaces and deletes documents", async () => {
      const students = (await create()).collection("students", Entry);
      await students.put("s-1", entry("s-1"));
      await students.put("s-1", entry("s-1", { grade: 2 }));
      const replaced = (await students.get("s-1")).unwrap();
      await students.delete("s-1");

      expect(replaced?.grade).toBe(2);
      expect((await students.get("s-1")).unwrap()).toBeUndefined();
    });

    it("finds documents by equality on several fields, including null and booleans", async () => {
      const students = (await create()).collection("students", Entry);
      await students.put("a", entry("a", { house: "red", active: true }));
      await students.put("b", entry("b", { house: "red", active: false }));
      await students.put("c", entry("c", { house: "blue", active: true, nickname: "cee" }));

      const red = (await students.find({ house: "red", active: true })).unwrap();
      const unnamed = (await students.find({ nickname: null })).unwrap();

      expect(red.map((s) => s.id)).toEqual(["a"]);
      expect(unnamed.map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("orders by id by default, or by a field, and limits", async () => {
      const students = (await create()).collection("students", Entry);
      await students.put("b", entry("b", { grade: 10 }));
      await students.put("a", entry("a", { grade: 9 }));
      await students.put("c", entry("c", { grade: 11 }));

      const byId = (await students.find({})).unwrap();
      const byGrade = (await students.find({}, { orderBy: "grade", limit: 2 })).unwrap();

      expect(byId.map((s) => s.id)).toEqual(["a", "b", "c"]);
      expect(byGrade.map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("keeps collections apart", async () => {
      const store = await create();
      await store.collection("students", Entry).put("s-1", entry("s-1"));

      expect((await store.collection("teachers", Entry).get("s-1")).unwrap()).toBeUndefined();
    });

    it("reports a stored document that no longer matches the schema", async () => {
      const store = await create();
      await store.collection("students", z.object({ id: z.string() })).put("s-1", { id: "s-1" });

      const read = await store.collection("students", Entry).get("s-1");

      expect(read.isErr() && DependencyFailure.is(read.error)).toBe(true);
    });

    it("does not share references with the caller", async () => {
      const students = (await create()).collection("students", Entry);
      const document = entry("s-1");
      await students.put("s-1", document);
      document.grade = 99;

      expect((await students.get("s-1")).unwrap()?.grade).toBe(1);
    });
  });
}
