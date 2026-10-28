import { describe, expect, it } from "vitest";
import { DependencyUnavailable, Result, type SchemaMigrator } from "@projected/application";
import { prepareSchema } from "@projected/runtime";

/** A migrator over an in-memory list of changes, recording the order it is applied in. */
function migrator(name: string, pending: string[], applied: string[] = []): SchemaMigrator {
  return {
    name,
    pending: async () => Result.ok([...pending]),
    apply: async () => {
      const changes = pending.splice(0);
      applied.push(name);
      return Result.ok(changes);
    },
  };
}

const unreachable: SchemaMigrator = {
  name: "projected",
  pending: async () => Result.err(new DependencyUnavailable({ dependency: "postgres", message: "connection refused" })),
  apply: async () => Result.err(new DependencyUnavailable({ dependency: "postgres", message: "connection refused" })),
};

describe("prepareSchema", () => {
  it("applies every migrator's pending changes in order and reports them", async () => {
    const order: string[] = [];

    const prepared = await prepareSchema([migrator("projected", ["core@1"], order), migrator("better-auth", ["create user"], order)]);

    expect(prepared.unwrap()).toEqual(["projected: core@1", "better-auth: create user"]);
    expect(order).toEqual(["projected", "better-auth"]);
  });

  it("refuses tables that are behind when only checking, naming what is pending and the command to run", async () => {
    const prepared = await prepareSchema([migrator("projected", ["core@2"]), migrator("better-auth", ["add user.role", "add user.banned"])], {
      apply: false,
    });

    expect(prepared.isErr() && prepared.error._tag).toBe("DependencyFailure");
    expect(prepared.isErr() && prepared.error.message).toBe(
      "The tables are behind this version (pending projected: core@2; better-auth: add user.role, add user.banned). Run `projected migrate` before starting it.",
    );
  });

  it("accepts current tables when only checking, and changes nothing", async () => {
    const applied: string[] = [];

    const prepared = await prepareSchema([migrator("projected", [], applied)], { apply: false });

    expect(prepared.unwrap()).toEqual([]);
    expect(applied).toEqual([]);
  });

  it("stops at the first migrator that cannot reach its database", async () => {
    const applied: string[] = [];

    const prepared = await prepareSchema([unreachable, migrator("better-auth", ["create user"], applied)]);

    expect(prepared.isErr() && prepared.error._tag).toBe("DependencyUnavailable");
    expect(applied).toEqual([]);
  });
});
