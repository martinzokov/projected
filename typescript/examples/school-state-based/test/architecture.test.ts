import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkArchitecture, formatViolations } from "@projected/architecture";

describe("architecture", () => {
  it("keeps every boundary", async () => {
    const report = await checkArchitecture(fileURLToPath(new URL("..", import.meta.url)), { flavour: "state-based" });

    expect(formatViolations(report.violations)).toBe("");
    expect(report.checked.dependencyCruiser).toBeGreaterThan(10);
    // Type-checked rules build a TypeScript program for the adapters: seconds, not milliseconds.
  }, 60_000);
});
