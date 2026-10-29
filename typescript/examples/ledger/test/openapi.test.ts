import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "@projected/http";
import { ledgerContracts } from "../src/application/port/driving/index.js";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * openapi.json is what clients build against. The contracts, with their errors' schemas and
 * descriptions, must describe exactly it — `projected check` holds the file to the code, and
 * this holds the code to the file.
 */
describe("the published API", () => {
  it("is the one openapi.json describes", () => {
    const { securitySchemes } = read("projected.json") as { securitySchemes: Record<string, unknown> };

    const document = openApiDocument(ledgerContracts, { version: "1.0.0", securitySchemes });

    expect(JSON.parse(JSON.stringify(document))).toEqual(read("openapi.json"));
  });
});
