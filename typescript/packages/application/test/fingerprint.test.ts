import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "@projected/application";

describe("sha256", () => {
  it.each([
    [""],
    ["abc"],
    ["The quick brown fox jumps over the lazy dog"],
    ["é ñ ü — multi-byte UTF-8"],
    ["emoji 🎓 outside the basic plane"],
    ["a".repeat(55)],
    ["a".repeat(56)],
    ["a".repeat(64)],
    ["x".repeat(1000)],
  ])("matches node:crypto for %j", (text) => {
    expect(sha256(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

describe("canonicalJson", () => {
  it("is independent of key order at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { d: [2, { y: 2, z: 1 }] }, b: 1 }));
  });
});
