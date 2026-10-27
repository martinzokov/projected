import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it, vi } from "vitest";

type Spec = Parameters<Validator["validate"]>[0];
import {
  DependencyFailure,
  DependencyUnavailable,
  Result,
  createApplication,
  defineCommand,
  defineContracts,
  defineError,
  defineQuery,
  z,
  type Application,
  type CommandHandler,
  type QueryHandler,
} from "@projected/application";
import { HttpStatusError, httpClient, httpHandler, httpService, openApiDocument, serve, type FetchHandler } from "@projected/http";
import { sequentialIds } from "@projected/testing";

class BookAlreadyBorrowed extends defineError("BookAlreadyBorrowed", {
  schema: z.object({ isbn: z.string() }),
  message: ({ isbn }) => `${isbn} is already borrowed`,
  description: "Someone else has the book.",
}) {}

const BorrowBook = defineCommand({
  type: "borrow-book",
  summary: "Borrow a book from the library",
  input: z.object({ isbn: z.string().min(10), member: z.string() }),
  output: z.object({ dueOn: z.iso.date() }),
  errors: [BookAlreadyBorrowed],
});

const AvailableBooks = defineQuery({
  type: "available-books",
  input: z.object({}),
  output: z.object({ isbns: z.array(z.string()) }),
});

const Explode = defineCommand({ type: "explode", input: z.object({}), output: z.object({}) });
const Flaky = defineQuery({ type: "flaky", input: z.object({}), output: z.object({}) });

const library = defineContracts({
  name: "library",
  description: "Lends books.",
  commands: [BorrowBook, Explode],
  queries: [AvailableBooks, Flaky],
});

function libraryApp() {
  const borrowed = new Set<string>();
  const borrowBook: CommandHandler<typeof BorrowBook> = ({ isbn }) => {
    if (borrowed.has(isbn)) return Result.err(new BookAlreadyBorrowed({ isbn }));
    borrowed.add(isbn);
    return Result.ok({ dueOn: "2024-02-01" });
  };
  const availableBooks: QueryHandler<typeof AvailableBooks> = () => Result.ok({ isbns: ["9780000000002"] });
  return createApplication(library, {
    ids: sequentialIds("msg"),
    commands: {
      "borrow-book@1": borrowBook,
      "explode@1": () => {
        throw new Error("secret internals");
      },
    },
    queries: {
      "available-books@1": availableBooks,
      "flaky@1": () => Result.err(new DependencyUnavailable({ dependency: "catalogue", message: "down" })),
    },
  });
}

const post = (handler: FetchHandler, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request(`http://library.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );

describe("httpHandler", () => {
  const handler = () => httpHandler(libraryApp(), { messageIds: sequentialIds("req").next });
  const borrow = { isbn: "9780000000001", member: "m-1" };

  it("runs a command and returns its output as an ok result", async () => {
    const response = await post(handler(), "/commands/borrow-book/version/1", borrow);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", value: { dueOn: "2024-02-01" } });
  });

  it("returns a business error with 200, because the exchange itself succeeded", async () => {
    const h = handler();
    await post(h, "/commands/borrow-book/version/1", borrow);

    const response = await post(h, "/commands/borrow-book/version/1", borrow);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "error",
      error: { type: "BookAlreadyBorrowed", message: "9780000000001 is already borrowed", data: { isbn: "9780000000001" } },
    });
  });

  it("runs a query, accepting an empty body for empty input", async () => {
    const response = await post(handler(), "/queries/available-books/version/1");

    expect(await response.json()).toEqual({ status: "ok", value: { isbns: ["9780000000002"] } });
  });

  it("answers invalid input with 400 problem details listing the issues", async () => {
    const response = await post(handler(), "/commands/borrow-book/version/1", { isbn: "short" });
    const body = (await response.json()) as { type: string; issues: { path: string[] }[] };

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(body.type).toBe("urn:projected:problem:invalid-input");
    expect(body.issues.map((issue) => issue.path)).toEqual([["isbn"], ["member"]]);
  });

  it("answers an unknown version with 404 unknown-operation", async () => {
    const response = await post(handler(), "/commands/borrow-book/version/2", borrow);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { type: string }).type).toBe("urn:projected:problem:unknown-operation");
  });

  it("answers paths outside the protocol with 404 not-found", async () => {
    const response = await post(handler(), "/books/123", {});

    expect(((await response.json()) as { type: string }).type).toBe("urn:projected:problem:not-found");
  });

  it("only accepts POST on operation routes", async () => {
    const response = await handler()(new Request("http://library.test/queries/available-books/version/1"));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects bodies that are not JSON", async () => {
    const h = handler();

    const wrongType = await post(h, "/queries/available-books/version/1", "isbn=1", { "content-type": "text/plain" });
    const malformed = await post(h, "/queries/available-books/version/1", "{oops");

    expect([wrongType.status, malformed.status]).toEqual([415, 400]);
  });

  it("maps an unavailable dependency to 503 with Retry-After", async () => {
    const response = await post(handler(), "/queries/flaky/version/1");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("maps a defect to an opaque 500", async () => {
    const response = await post(handler(), "/commands/explode/version/1");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret internals");
  });

  it("propagates correlation headers and generates a message id", async () => {
    const response = await post(handler(), "/queries/available-books/version/1", {}, { "x-correlation-id": "flow-1" });

    expect(response.headers.get("x-correlation-id")).toBe("flow-1");
    expect(response.headers.get("x-message-id")).toBe("req-1");
  });

  it("runs batches item by item, reporting each outcome", async () => {
    const response = await post(handler(), "/commands", {
      commands: [
        { type: "borrow-book", version: 1, data: borrow },
        { type: "borrow-book", version: 1, data: borrow },
        { type: "borrow-book", version: 7, data: borrow },
        { nonsense: true },
      ],
    });
    const { results } = (await response.json()) as { results: { status: string; problem?: { status: number } }[] };

    expect(response.status).toBe(200);
    expect(results.map((r) => r.status)).toEqual(["ok", "error", "failed", "failed"]);
    expect(results[2]?.problem?.status).toBe(404);
  });

  it("refuses batches over the limit", async () => {
    const h = httpHandler(libraryApp(), { maxBatchSize: 1 });

    const response = await post(h, "/queries", { queries: [{ type: "available-books", version: 1 }, { type: "available-books", version: 1 }] });

    expect(response.status).toBe(413);
  });

  it("can be mounted under a base path", async () => {
    const h = httpHandler(libraryApp(), { basePath: "/api/" });

    const inside = await post(h, "/api/queries/available-books/version/1");
    const outside = await post(h, "/queries/available-books/version/1");

    expect([inside.status, outside.status]).toEqual([200, 404]);
  });

  it("serves health and the OpenAPI document", async () => {
    const h = handler();

    const health = await h(new Request("http://library.test/health"));
    const openapi = await h(new Request("http://library.test/openapi.json"));

    expect(await health.json()).toEqual({ status: "ok" });
    expect(((await openapi.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });
});

describe("openApiDocument", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const validator = new Validator();

    const result = await validator.validate(structuredClone(openApiDocument(library, { version: "1.2.3" })) as unknown as Spec);

    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("has one POST path per operation version, named for the business operation", () => {
    const document = openApiDocument(library);

    expect(Object.keys(document.paths)).toEqual([
      "/commands/borrow-book/version/1",
      "/commands/explode/version/1",
      "/queries/available-books/version/1",
      "/queries/flaky/version/1",
      "/commands",
      "/queries",
      "/health",
    ]);
    expect((document.paths["/commands/borrow-book/version/1"] as { post: { operationId: string } }).post.operationId).toBe(
      "borrowBookV1",
    );
  });

  it("documents declared business errors in the 200 response", () => {
    const document = openApiDocument(library);
    const schemas = document.components.schemas as Record<string, { properties?: Record<string, unknown>; description?: string }>;

    expect(schemas.BookAlreadyBorrowed?.properties?.type).toEqual({ const: "BookAlreadyBorrowed" });
    expect(schemas.BookAlreadyBorrowed?.description).toBe("Someone else has the book.");
    expect(JSON.stringify(document.paths["/commands/borrow-book/version/1"])).toContain("#/components/schemas/BookAlreadyBorrowed");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(openApiDocument(library))).toBe(JSON.stringify(openApiDocument(library)));
  });

  it("hoists recursive definitions so references resolve", async () => {
    type Node = { name: string; children: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(NodeSchema) }));
    const Tree = defineQuery({ type: "tree", input: z.object({}), output: z.object({ root: NodeSchema }) });

    const document = openApiDocument(defineContracts({ name: "trees", queries: [Tree] }));
    const result = await new Validator().validate(structuredClone(document) as unknown as Spec);

    expect(result.valid).toBe(true);
    expect(JSON.stringify(document)).not.toContain('"#/$defs/');
  });
});

describe("httpService", () => {
  const throughHandler = (app: Application<typeof library>) => {
    const handler = httpHandler(app);
    return httpService(library, {
      baseUrl: "http://library.test",
      fetch: (input, init) => handler(new Request(input, init)),
    });
  };

  it("returns typed output", async () => {
    const outcome = await throughHandler(libraryApp()).execute(BorrowBook, { isbn: "9780000000001", member: "m" });

    expect(outcome.unwrap()).toEqual({ dueOn: "2024-02-01" });
  });

  it("rebuilds business errors as instances of the contract's classes", async () => {
    const service = throughHandler(libraryApp());
    await service.execute(BorrowBook, { isbn: "9780000000001", member: "m" });

    const outcome = await service.execute(BorrowBook, { isbn: "9780000000001", member: "m" });

    expect(outcome.isErr() && outcome.error instanceof BookAlreadyBorrowed).toBe(true);
  });

  it("forwards correlation from the calling context", async () => {
    const seen = vi.fn();
    const service = httpService(library, {
      baseUrl: "http://library.test",
      fetch: async (input, init) => {
        seen(new Headers(init?.headers).get("x-correlation-id"));
        return httpHandler(libraryApp())(new Request(input, init));
      },
    });

    await service.execute(AvailableBooks, {}, {
      metadata: { messageId: "m-1", correlationId: "flow-9", causationId: undefined, idempotencyKey: undefined },
    });

    expect(seen).toHaveBeenCalledWith("flow-9");
  });

  it("maps 503 to DependencyUnavailable and a protocol rejection to DependencyFailure", async () => {
    const service = throughHandler(libraryApp());

    const unavailable = await service.execute(Flaky, {});
    const rejected = await service.execute(BorrowBook, { isbn: "x", member: "m" });

    expect(unavailable.isErr() && DependencyUnavailable.is(unavailable.error)).toBe(true);
    expect(rejected.isErr() && DependencyFailure.is(rejected.error)).toBe(true);
  });

  it("maps a network failure to DependencyUnavailable", async () => {
    const service = httpService(library, {
      baseUrl: "http://library.test",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });

    const outcome = await service.execute(AvailableBooks, {});

    expect(outcome.isErr() && DependencyUnavailable.is(outcome.error)).toBe(true);
  });

  it("talks to a real server", async () => {
    const server = await serve(httpHandler(libraryApp()), { port: 0, hostname: "127.0.0.1" });
    try {
      const outcome = await httpService(library, { baseUrl: server.url }).execute(AvailableBooks, {});

      expect(outcome.unwrap()).toEqual({ isbns: ["9780000000002"] });
    } finally {
      await server.close();
    }
  });
});

describe("httpClient", () => {
  const Weather = z.object({ celsius: z.number() });
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("parses successful bodies with the given schema", async () => {
    const client = httpClient({ dependency: "weather", baseUrl: "https://weather.test", fetch: respond(200, { celsius: 21 }) });

    const outcome = await client.request({ method: "GET", path: "/today", query: { city: "Sofia" }, response: Weather });

    expect(outcome.unwrap().body).toEqual({ celsius: 21 });
  });

  it("returns expected error statuses as data", async () => {
    const client = httpClient({ dependency: "weather", baseUrl: "https://weather.test", fetch: respond(404, { error: "no city" }) });

    const outcome = await client.request({ method: "GET", path: "/today", response: Weather, expectedErrors: [404] });

    expect(outcome.isErr() && HttpStatusError.is(outcome.error) && outcome.error.status).toBe(404);
  });

  it("separates retryable from non-retryable failures", async () => {
    const down = httpClient({ dependency: "weather", baseUrl: "https://weather.test", fetch: respond(503, {}) });
    const broken = httpClient({ dependency: "weather", baseUrl: "https://weather.test", fetch: respond(200, { kelvin: 1 }) });

    const unavailable = await down.request({ method: "GET", path: "/today", response: Weather });
    const failure = await broken.request({ method: "GET", path: "/today", response: Weather });

    expect(unavailable.isErr() && DependencyUnavailable.is(unavailable.error)).toBe(true);
    expect(failure.isErr() && DependencyFailure.is(failure.error)).toBe(true);
  });
});
