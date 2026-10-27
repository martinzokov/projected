import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkArchitecture, formatViolations } from "@projected/architecture";

describe("architecture", () => {
  it("keeps every boundary", async () => {
    const report = await checkArchitecture(fileURLToPath(new URL("..", import.meta.url)));

    expect(formatViolations(report.violations)).toBe("");
    expect(report.checked.dependencyCruiser).toBeGreaterThan(10);
  });
});
