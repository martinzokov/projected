import { describe, expect, it } from "vitest";
import { recordingLogger } from "@projected/testing/event-sourced";
import { web } from "../src/infrastructure/config/web.js";
import { testLedger } from "./ledger.js";

const app = "https://app.ledger.test";
const site = () => web(testLedger().handler, { corsOrigins: [app], maxBodyBytes: 1024 });

describe("ledger on the web", () => {
  it("lets a listed origin call it from a browser, sending the protocol's headers", async () => {
    const preflight = await site().request("/commands", {
      method: "OPTIONS",
      headers: { origin: app, "access-control-request-method": "POST", "access-control-request-headers": "content-type, idempotency-key" },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(app);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  });

  it("gives other origins nothing that would let a browser read the answer", async () => {
    const response = await site().request("/health/live", { headers: { origin: "https://elsewhere.test" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a body over the limit with the protocol's 413", async () => {
    const response = await site().request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ type: "urn:projected:problem:payload-too-large" });
  });

  it("logs each request with its status and message ids, and leaves health probes out", async () => {
    const log = recordingLogger();
    const logged = web(testLedger().handler, { corsOrigins: [], log });

    await logged.request("/health/live");
    await logged.request("/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: [] }) });

    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({ message: "request", fields: { method: "POST", path: "/commands", status: 200, message_id: "request-1" } });
  });
});
