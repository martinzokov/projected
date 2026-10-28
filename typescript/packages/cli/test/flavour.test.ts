import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineCommand, defineContracts, z } from "@projected/application";
import { contractsLock, loadProject, updateLock } from "@projected/cli";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function projectWith(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "projected-cli-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(content));
  return root;
}

const contracts = defineContracts({
  name: "desk",
  access: "public",
  commands: [defineCommand({ type: "open-ticket", input: z.object({}), output: z.object({}) })],
});

describe("the project's flavour", () => {
  it("is required in projected.json", () => {
    const root = projectWith({ "projected.json": {} });

    expect(() => loadProject(root)).toThrow(/must set "flavour" to "event-sourced" or "state-based"/);
  });

  it("must be one of the known flavours", () => {
    const root = projectWith({ "projected.json": { flavour: "crud" } });

    expect(() => loadProject(root)).toThrow(/found "crud"/);
  });

  it("is recorded in the lock, and kept once recorded", () => {
    const first = updateLock(undefined, contracts, { flavour: "state-based" });
    const later = updateLock(first, contracts, { flavour: "event-sourced" });

    expect([first.flavour, later.flavour]).toEqual(["state-based", "state-based"]);
  });

  it("cannot change once locked, not even with --update", async () => {
    const root = projectWith({
      "projected.json": { flavour: "event-sourced" },
      "contracts.lock.json": { lockfileVersion: 2, service: "desk", flavour: "state-based", operations: {} },
    });

    const outcome = await contractsLock(loadProject(root), { update: true, allowRemoval: false });

    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toMatch(/created state-based .* now says event-sourced/);
  });
});
