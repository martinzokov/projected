import { describe, expect, it } from "vitest";
import { conformance } from "@projected/cli";
import { serve } from "@projected/http/node";
import { testSchool } from "./school.js";

/** The language-neutral scenarios in spec/conformance, over a real socket: the service as any client sees it. */
describe("the school, black box", () => {
  it("passes the protocol and school conformance suites", async () => {
    const { handler } = testSchool();
    const server = await serve(handler, { port: 0, hostname: "127.0.0.1" });
    try {
      const result = await conformance({ url: server.url, suites: ["protocol", "school"] });

      expect(result.lines.filter((line) => line.includes("✗"))).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);
});
