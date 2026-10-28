import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mutation testing runs the tests against instrumented copies of src/, which are not the code this
// test is about: it checks the code you wrote, and `projected check` runs it on that in CI. The
// checker is imported in the test, since a skipped file still loads what it imports.
describe.skipIf(process.env["PROJECTED_MUTATION"] !== undefined)("architecture", () => {
  it("keeps every boundary", async () => {
    const { checkArchitecture, formatViolations } = await import("@projected/architecture");
    const report = await checkArchitecture(fileURLToPath(new URL("..", import.meta.url)), { flavour: "event-sourced" });

    expect(formatViolations(report.violations)).toBe("");
    expect(report.checked.dependencyCruiser).toBeGreaterThan(10);
    // Type-checked rules build a TypeScript program for the adapters: seconds, not milliseconds.
  }, 60_000);
});
