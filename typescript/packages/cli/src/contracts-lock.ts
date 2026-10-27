import type { AnyContracts, AnyOperationContract } from "@projected/application";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Contract immutability. Once a `(type, version)` is published, its input, output and errors
 * never change — the article's rule: evolve by adding a new version and deprecating the old one.
 * The lock file records a fingerprint per operation; CI compares it with the code.
 */

export interface ContractsLock {
  readonly lockfileVersion: 1;
  readonly service: string;
  /** `"command enlist-student@1"` → `"sha256-…"` */
  readonly operations: Readonly<Record<string, string>>;
}

/** Keys that only document a schema. Changing them is not a contract change. */
const DOCUMENTATION_KEYS = new Set(["description", "title", "examples", "deprecated", "$comment"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !DOCUMENTATION_KEYS.has(key))
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

const schemaOf = (schema: z.ZodType, io: "input" | "output") =>
  canonical(z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }));

export const operationKey = (contract: AnyOperationContract) => `${contract.kind} ${contract.key}`;

/** The fingerprint of everything a client depends on: input, output and the declared errors. */
export function fingerprint(contract: AnyOperationContract): string {
  const shape = {
    input: schemaOf(contract.input, "input"),
    output: schemaOf(contract.output, "output"),
    errors: contract.errors
      .map((error) => ({ tag: error.tag, data: schemaOf(error.schema, "output") }))
      .sort((a, b) => a.tag.localeCompare(b.tag)),
  };
  return `sha256-${createHash("sha256").update(JSON.stringify(shape)).digest("base64")}`;
}

export function lockOf(contracts: AnyContracts): ContractsLock {
  const operations = [...contracts.commands, ...contracts.queries] as AnyOperationContract[];
  return {
    lockfileVersion: 1,
    service: contracts.name,
    operations: Object.fromEntries(
      operations.map((contract) => [operationKey(contract), fingerprint(contract)] as const).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export interface LockComparison {
  /** In the code, not yet in the lock. Fine — run `projected contracts --update`. */
  readonly added: readonly string[];
  /** Published, and changed since. Never fine: add a new version instead. */
  readonly changed: readonly string[];
  /** Published, and gone from the code. A breaking change for every client still using it. */
  readonly removed: readonly string[];
}

export function compareLock(lock: ContractsLock, contracts: AnyContracts): LockComparison {
  const current = lockOf(contracts).operations;
  const locked = lock.operations;
  return {
    added: Object.keys(current).filter((key) => !(key in locked)),
    changed: Object.keys(current).filter((key) => key in locked && locked[key] !== current[key]),
    removed: Object.keys(locked).filter((key) => !(key in current)),
  };
}

/**
 * The lock after accepting new operations (and, when allowed, removals). Changed operations
 * keep their published fingerprint, so the check keeps failing until the change is reverted.
 */
export function updateLock(lock: ContractsLock | undefined, contracts: AnyContracts, options: { allowRemoval?: boolean } = {}): ContractsLock {
  const current = lockOf(contracts);
  const operations: Record<string, string> = { ...current.operations, ...(lock?.operations ?? {}) };
  if (options.allowRemoval) {
    for (const key of Object.keys(operations)) if (!(key in current.operations)) delete operations[key];
  }
  return {
    lockfileVersion: 1,
    service: contracts.name,
    operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))),
  };
}
