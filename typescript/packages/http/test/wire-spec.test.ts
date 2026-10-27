import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, defineError, z } from "@projected/application";
import { httpHandler } from "@projected/http";
import { sequentialIds } from "@projected/testing";

/** The HTTP binding must produce exactly the shapes in spec/wire.schema.json. */

const spec = JSON.parse(readFileSync(new URL("../../../../spec/wire.schema.json", import.meta.url), "utf8")) as object;
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(spec);
const conforms = (definition: string, value: unknown) => {
  const validate = ajv.getSchema(`urn:projected:spec:wire:1#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`No $def ${definition}`);
  return validate(value) ? [] : validate.errors;
};

class Full extends defineError("Full", { schema: z.object({ capacity: z.number() }) }) {}
const Join = defineCommand({
  type: "join-club",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ memberNumber: z.number() }),
  errors: [Full],
});
let members = 0;
const handler = httpHandler(
  createApplication(defineContracts({ name: "club", access: "public", commands: [Join] }), {
    ids: sequentialIds(),
    commands: { "join-club@1": () => (members++ < 1 ? Result.ok({ memberNumber: members }) : Result.err(new Full({ capacity: 1 }))) },
  }),
);
const post = async (path: string, body: unknown) =>
  (await handler(new Request(`http://club.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).json();

describe("HTTP binding conforms to spec/wire.schema.json", () => {
  it("for ok and business error results", async () => {
    expect(conforms("OperationResult", await post("/commands/join-club/version/1", { name: "Ada" }))).toEqual([]);
    expect(conforms("OperationResult", await post("/commands/join-club/version/1", { name: "Bob" }))).toEqual([]);
  });

  it("for problem details", async () => {
    expect(conforms("ProblemDetails", await post("/commands/join-club/version/1", { name: "" }))).toEqual([]);
    expect(conforms("ProblemDetails", await post("/commands/join-club/version/9", {}))).toEqual([]);
  });

  it("for batches", async () => {
    const batch = { commands: [{ type: "join-club", version: 1, data: { name: "Cy" } }, { type: "join-club", version: 3, data: {} }] };

    expect(conforms("CommandBatch", batch)).toEqual([]);
    expect(conforms("BatchResult", await post("/commands", batch))).toEqual([]);
  });
});
