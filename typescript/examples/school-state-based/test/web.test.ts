import { describe, expect, it } from "vitest";
import { web } from "../src/infrastructure/config/web.js";
import { testSchool } from "./school.js";

const app = "https://app.school.test";
const site = () => web(testSchool().handler, { corsOrigins: [app], maxBodyBytes: 1024 });

describe("the school on the web", () => {
  it("lets a listed origin call it from a browser, sending the protocol's headers", async () => {
    const preflight = await site().request("/commands/enlist-student/version/2", {
      method: "OPTIONS",
      headers: { origin: app, "access-control-request-method": "POST", "access-control-request-headers": "content-type, idempotency-key" },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(app);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  });

  it("lets a listed origin read the message ids it gets back", async () => {
    const response = await site().request("/health/live", { headers: { origin: app } });

    expect(response.headers.get("access-control-allow-origin")).toBe(app);
    expect(response.headers.get("access-control-expose-headers")).toContain("x-correlation-id");
  });

  it("gives other origins nothing that would let a browser read the answer", async () => {
    const response = await site().request("/health/live", { headers: { origin: "https://elsewhere.test" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a body over the limit with the protocol's 413", async () => {
    const response = await site().request("/commands/enlist-student/version/2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer registrar-token" },
      body: JSON.stringify({ padding: "x".repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ type: "urn:projected:problem:payload-too-large", status: 413 });
  });

  it("serves the service through it, with security headers", async () => {
    const response = await site().request("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
