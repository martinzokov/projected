import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "@projected/cli";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function withConfig(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "projected-rules-"));
  roots.push(root);
  writeFileSync(join(root, "projected.json"), JSON.stringify(config));
  return root;
}

describe("design rule configuration", () => {
  it("accepts a level for each configurable rule, and an allow list for single-aggregate-commands", () => {
    const root = withConfig({
      flavour: "event-sourced",
      rules: {
        "business-operation-names": "warn",
        "past-tense-events": "off",
        "single-aggregate-commands": { level: "error", allow: ["src/application/usecase/transfer.ts"] },
      },
    });

    expect(loadProject(root).config.rules?.["past-tense-events"]).toBe("off");
  });

  it("refuses rules that are not configurable, naming the ones that are", () => {
    const root = withConfig({ flavour: "event-sourced", rules: { "domain-is-pure": "off" } });

    expect(() => loadProject(root)).toThrow(/unknown rule "domain-is-pure".*business-operation-names, past-tense-events, single-aggregate-commands/);
  });

  it("refuses levels other than error, warn and off", () => {
    const root = withConfig({ flavour: "event-sourced", rules: { "past-tense-events": "info" } });

    expect(() => loadProject(root)).toThrow(/must be "error", "warn" or "off", found "info"/);
  });
});
