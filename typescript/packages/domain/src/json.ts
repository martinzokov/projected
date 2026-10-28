import { panic } from "better-result";
import { z } from "zod";

/**
 * Data that is stored or sent must survive JSON, so its schema needs a JSON Schema form on the
 * side named: no `z.date()`, `z.bigint()`, `z.map()`, functions or transforms. Checked once, at
 * definition, because an in-memory store would carry a `Date` through and a real one would not.
 */
export function assertJsonCompatible(label: string, what: string, schema: z.ZodType, io: "input" | "output"): void {
  try {
    z.toJSONSchema(schema, { io, unrepresentable: "throw" });
  } catch (cause) {
    panic(`${label}: ${what} schema is not JSON-compatible (use z.iso.date(), z.iso.datetime(), plain objects)`, cause);
  }
}
