import { describe, expect, it } from "vitest";
import { DependencyUnavailable } from "@projected/application";
import { jsonLogger } from "@projected/runtime";
import { fixedClock, recordingTelemetry } from "@projected/testing";

function logged(options: Parameters<typeof jsonLogger>[0] = {}) {
  const lines: string[] = [];
  const log = jsonLogger({ clock: fixedClock("2024-03-01T10:00:00.000Z"), write: (line) => lines.push(line), ...options });
  return { log, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("the JSON logger", () => {
  it("writes one JSON object per record, with the logger's and the record's fields", () => {
    const { log, records } = logged({ fields: { service: "school" } });

    log.child({ component: "relay" }).info("published", { topic: "school.events", count: 2 });

    expect(records()).toEqual([
      { time: "2024-03-01T10:00:00.000Z", level: "info", message: "published", service: "school", component: "relay", topic: "school.events", count: 2 },
    ]);
  });

  it("drops records below its level", () => {
    const { log, records } = logged({ level: "warn" });

    log.debug("detail");
    log.info("progress");
    log.warn("trouble");

    expect(records().map((record) => record["level"])).toEqual(["warn"]);
  });

  it("writes an error as its type, message, stack and cause", () => {
    const { log, records } = logged();
    const error = new DependencyUnavailable({ dependency: "postgres", message: "postgres: connection refused", cause: new Error("ECONNREFUSED") });

    log.error("defect", { error });

    expect(records()[0]?.["error"]).toMatchObject({
      type: "DependencyUnavailable",
      message: "postgres: connection refused",
      dependency: "postgres",
      stack: expect.stringContaining("DependencyUnavailable"),
      cause: { type: "Error", message: "ECONNREFUSED" },
    });
  });

  it("names the active trace, so a record leads to its spans", async () => {
    const telemetry = recordingTelemetry();
    const { log, records } = logged({ telemetry });

    await telemetry.span("command enlist-student@2", {}, async () => log.info("inside"));
    log.info("outside");

    expect(records()[0]?.["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(records()[0]?.["span_id"]).toMatch(/^[0-9a-f]{16}$/);
    expect(records()[1]?.["trace_id"]).toBeUndefined();
  });

  it("still writes a record whose fields cannot be serialized", () => {
    const { log, records } = logged();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    log.warn("odd", { circular });

    expect(records()).toEqual([{ time: "2024-03-01T10:00:00.000Z", level: "warn", message: "odd", unserializable: ["circular"] }]);
  });
});
