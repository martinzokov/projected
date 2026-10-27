import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it, vi } from "vitest";
import {
  DependencyUnavailable,
  Result,
  createApplication,
  defineCommand,
  defineContracts,
  defineQuery,
  z,
  type Authenticator,
} from "@projected/application";
import { httpHandler, httpService, openApiDocument, type FetchHandler } from "@projected/http";
import { inMemoryIdempotencyStore } from "@projected/store-memory";
import { principal, recordingTelemetry, sequentialIds, tokenAuthenticator } from "@projected/testing";

type Spec = Parameters<Validator["validate"]>[0];

const PlaceOrder = defineCommand({
  type: "place-order",
  input: z.object({ sku: z.string() }),
  output: z.object({ orderId: z.string(), placedBy: z.string() }),
  access: { permissions: ["orders:place"] },
});
const MyOrders = defineQuery({ type: "my-orders", input: z.object({}), output: z.object({ count: z.number() }) });
const Menu = defineQuery({ type: "menu", input: z.object({}), output: z.object({ items: z.array(z.string()) }), access: "public" });
const shop = defineContracts({ name: "shop", access: "authenticated", commands: [PlaceOrder], queries: [MyOrders, Menu] });

const buyer = principal("u-buyer", ["orders:place"]);
const browser = principal("u-browser");

function shopHandler(options: { authenticator?: Authenticator; routes?: Record<string, FetchHandler> } = {}) {
  const placed: string[] = [];
  const telemetry = recordingTelemetry();
  const app = createApplication(shop, {
    ids: sequentialIds("msg"),
    telemetry,
    idempotency: { store: inMemoryIdempotencyStore() },
    commands: {
      "place-order@1": ({ sku }, context) => {
        placed.push(sku);
        return Result.ok({ orderId: `o-${placed.length}`, placedBy: context.metadata.principal?.id ?? "nobody" });
      },
    },
    queries: { "my-orders@1": () => Result.ok({ count: placed.length }), "menu@1": () => Result.ok({ items: ["tea"] }) },
  });
  const handler = httpHandler(app, {
    authenticator: options.authenticator ?? tokenAuthenticator({ "buyer-token": buyer, "browser-token": browser }),
    ...(options.routes === undefined ? {} : { routes: options.routes }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`http://shop.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { app, handler, post, placed, telemetry };
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe("authentication over HTTP", () => {
  it("passes the authenticated principal to the handler", async () => {
    const { post } = shopHandler();

    const response = await post("/commands/place-order/version/1", { sku: "tea" }, as("buyer-token"));

    expect(await response.json()).toEqual({ status: "ok", value: { orderId: "o-1", placedBy: "u-buyer" } });
  });

  it("answers anonymous callers with 401 and a challenge", async () => {
    const { post } = shopHandler();

    const response = await post("/queries/my-orders/version/1", {});

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(((await response.json()) as { type: string }).type).toBe("urn:projected:problem:unauthenticated");
  });

  it("answers callers lacking a permission with 403", async () => {
    const { post, placed } = shopHandler();

    const response = await post("/commands/place-order/version/1", { sku: "tea" }, as("browser-token"));

    expect(response.status).toBe(403);
    expect(placed).toEqual([]);
  });

  it("treats unknown credentials as anonymous", async () => {
    const { post } = shopHandler();

    expect((await post("/queries/menu/version/1", {}, as("forged"))).status).toBe(200);
    expect((await post("/queries/my-orders/version/1", {}, as("forged"))).status).toBe(401);
  });

  it("answers 503 when the authenticator cannot reach its backend", async () => {
    const { post } = shopHandler({
      authenticator: { authenticate: async () => Result.err(new DependencyUnavailable({ dependency: "auth", message: "down" })) },
    });

    expect((await post("/queries/menu/version/1", {})).status).toBe(503);
  });

  it("serves mounted routes, such as an auth provider's sign-in endpoints", async () => {
    const signIn = vi.fn(async () => new Response("signed in"));
    const { handler } = shopHandler({ routes: { "/api/auth": signIn } });

    const response = await handler(new Request("http://shop.test/api/auth/sign-in/email", { method: "POST" }));

    expect(await response.text()).toBe("signed in");
    expect(signIn).toHaveBeenCalledOnce();
  });
});

describe("duplicate command protection over HTTP", () => {
  it("replays the outcome for a repeated Idempotency-Key", async () => {
    const { post, placed } = shopHandler();
    const headers = { ...as("buyer-token"), "idempotency-key": "checkout-1" };

    const first = await (await post("/commands/place-order/version/1", { sku: "tea" }, headers)).json();
    const again = await (await post("/commands/place-order/version/1", { sku: "tea" }, headers)).json();

    expect(again).toEqual(first);
    expect(placed).toEqual(["tea"]);
  });

  it("answers 422 when a key is reused for a different request", async () => {
    const { post } = shopHandler();
    const headers = { ...as("buyer-token"), "idempotency-key": "checkout-1" };
    await post("/commands/place-order/version/1", { sku: "tea" }, headers);

    const response = await post("/commands/place-order/version/1", { sku: "cake" }, headers);

    expect(response.status).toBe(422);
  });

  it("protects every item of a batch sent with a key", async () => {
    const { post, placed } = shopHandler();
    const headers = { ...as("buyer-token"), "idempotency-key": "batch-1" };
    const batch = { commands: [{ type: "place-order", version: 1, data: { sku: "tea" } }, { type: "place-order", version: 1, data: { sku: "cake" } }] };

    await post("/commands", batch, headers);
    const replayed = (await (await post("/commands", batch, headers)).json()) as { results: unknown[] };

    expect(placed).toEqual(["tea", "cake"]);
    expect(replayed.results).toHaveLength(2);
  });
});

describe("tracing over HTTP", () => {
  const remote = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  it("continues the caller's trace in a server span around the operation", async () => {
    const { post, telemetry } = shopHandler();

    await post("/queries/menu/version/1", {}, { traceparent: remote });

    const server = telemetry.named("POST /queries/{type}/version/{version}")[0];
    const dispatch = telemetry.named("query menu@1")[0];
    expect(server).toMatchObject({ kind: "server", traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331" });
    expect(server?.attributes["http.response.status_code"]).toBe(200);
    expect(dispatch?.parentSpanId).toBe(server?.spanId);
  });

  it("sends the current trace to services it calls", async () => {
    const telemetry = recordingTelemetry();
    const seen = vi.fn();
    const { handler } = shopHandler();
    const service = httpService(shop, {
      baseUrl: "http://shop.test",
      telemetry,
      headers: () => as("buyer-token"),
      fetch: async (input, init) => {
        seen(new Headers(init?.headers).get("traceparent"));
        return handler(new Request(input, init));
      },
    });

    await telemetry.span("calling code", {}, () => service.execute(Menu, {}));

    const client = telemetry.named("query shop/menu@1")[0];
    expect(seen).toHaveBeenCalledWith(`00-${client?.traceId}-${client?.spanId}-01`);
  });
});

describe("OpenAPI for access rules", () => {
  const schemes = { bearer: { type: "http", scheme: "bearer" } };
  const document = openApiDocument(shop, { securitySchemes: schemes });
  const operation = (path: string) => (document.paths[path] as { post: Record<string, unknown> }).post;

  it("documents each operation's access, security and refusals", () => {
    expect(operation("/commands/place-order/version/1")).toMatchObject({
      "x-projected-access": { permissions: ["orders:place"] },
      security: [{ bearer: [] }],
    });
    expect(Object.keys(operation("/commands/place-order/version/1").responses as object)).toEqual(
      expect.arrayContaining(["401", "403", "409", "422"]),
    );
  });

  it("marks public operations as needing no credentials", () => {
    expect(operation("/queries/menu/version/1")).toMatchObject({ "x-projected-access": "public", security: [] });
    expect(Object.keys(operation("/queries/menu/version/1").responses as object)).not.toContain("401");
  });

  it("stays a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(structuredClone(document) as unknown as Spec);

    expect(result.errors ?? []).toEqual([]);
  });
});

