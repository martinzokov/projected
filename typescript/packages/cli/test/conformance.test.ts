import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyUnavailable, Result, createApplication, defineContracts } from "@projected/application";
import { httpHandler } from "@projected/http";
import { conformance } from "@projected/cli";

/** A service with no operations, served in process: enough for the protocol suite. */
const empty = () => httpHandler(createApplication(defineContracts({ name: "empty", access: "public" }), { ids: { next: () => "id" } }));
const asFetch = (handler: (request: Request) => Promise<Response>) => (url: string, init: RequestInit) => handler(new Request(url, init));

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function suiteFile(suite: object): string {
  const dir = mkdtempSync(join(tmpdir(), "projected-conformance-"));
  dirs.push(dir);
  writeFileSync(join(dir, "suite.json"), JSON.stringify(suite));
  return join(dir, "suite.json");
}

describe("projected conformance", () => {
  it("passes a service that keeps the protocol", async () => {
    const result = await conformance({ url: "http://empty.test", fetch: asFetch(empty()) });

    expect(result.lines.filter((line) => line.includes("✗"))).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names each scenario a service fails, with the step and what differed", async () => {
    const handler = empty();
    // Liveness that answers 500, and message ids that are not echoed.
    const broken = async (request: Request) => {
      if (new URL(request.url).pathname === "/health/live") return new Response("{}", { status: 500 });
      const response = await handler(request);
      const headers = new Headers(response.headers);
      headers.delete("x-message-id");
      return new Response(response.body, { status: response.status, headers });
    };

    const result = await conformance({ url: "http://broken.test", fetch: asFetch(broken) });

    const failures = result.lines.filter((line) => line.includes("✗"));
    expect(result.ok).toBe(false);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/✗ answers liveness \(§3.5\) — step 1 \(GET \/health\/live\): status 500, expected 200/);
    expect(failures[1]).toMatch(/✗ echoes the message id .* step 1 .*: header x-message-id: nothing, expected "m-[0-9a-f]+-\d+"/);
  });

  it("matches bodies by the scenario rules: listed keys, whole arrays, types, captures", async () => {
    const answers = [{ id: "c-41", tags: ["a", "b"], count: 2, extra: true }, { echoed: "c-41" }];
    const fetch = async () => new Response(JSON.stringify(answers.shift()), { headers: { "content-type": "application/json; charset=utf-8" } });
    const file = suiteFile({
      suite: "rules",
      description: "matching",
      scenarios: [
        {
          name: "captures and reuses a value",
          steps: [
            { request: { method: "GET", path: "/a" }, expect: { status: 200, headers: { "content-type": "application/json" }, body: { id: "$capture:thing", tags: ["a", "$string"], count: "$number" } } },
            { request: { method: "GET", path: "/b/${thing}" }, expect: { status: 200, body: { echoed: "${thing}" } } },
          ],
        },
      ],
    });

    const result = await conformance({ url: "http://rules.test", suites: [file], fetch });

    expect(result.lines).toEqual(["conformance: rules — 1/1 scenarios", "  ✓ captures and reuses a value", "conformance: 1/1 scenarios pass against http://rules.test"]);
  });

  it("fails an array of another length, and an object without a listed key", async () => {
    const fetch = async () => new Response(JSON.stringify({ tags: ["a", "b", "c"] }));
    const file = suiteFile({
      suite: "rules",
      description: "matching",
      scenarios: [{ name: "lengths", steps: [{ request: { method: "GET", path: "/a" }, expect: { status: 200, body: { tags: ["a", "b"], missing: "$any" } } }] }],
    });

    const result = await conformance({ url: "http://rules.test", suites: [file], fetch });

    expect(result.lines[1]).toBe('  ✗ lengths — step 1 (GET /a): body.tags: ["a","b","c"], expected 2 items\n    body.missing: missing');
  });

  it("refuses a suite that does not follow the scenario format", async () => {
    const file = suiteFile({ suite: "Bad Name", scenarios: [] });

    const result = await conformance({ url: "http://x.test", suites: [file], fetch: asFetch(empty()) });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/is not a valid suite: /);
  });

  it("is answered by a service whose readiness check is down, as long as it says so properly", async () => {
    const app = createApplication(defineContracts({ name: "empty", access: "public" }), {
      ids: { next: () => "id" },
      readiness: [{ name: "postgres", check: async () => Result.err(new DependencyUnavailable({ dependency: "postgres", message: "down" })) }],
    });

    const result = await conformance({ url: "http://unready.test", fetch: asFetch(httpHandler(app)) });

    expect(result.ok).toBe(true);
  });
});
