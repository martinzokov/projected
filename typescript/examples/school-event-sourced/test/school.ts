import { httpHandler } from "@projected/http";
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore } from "@projected/store-memory/event-sourced";
import { fixedClock, principal, sequentialIds, tokenAuthenticator } from "@projected/testing/event-sourced";
import { composeSchool } from "../src/infrastructure/config/school.js";

export const registrar = principal("u-registrar", ["students:manage"]);
export const teacher = principal("u-teacher");

/** The real composition, with deterministic time and ids and in-memory stores, served by the real HTTP handler. */
export function testSchool() {
  const clock = fixedClock("2023-10-01T09:00:00.000Z");
  const defects: Error[] = [];
  const eventStore = inMemoryEventStore({ clock, ids: sequentialIds("event") });
  const app = composeSchool({
    eventStore,
    checkpoints: inMemoryCheckpointStore(),
    documents: inMemoryDocumentStore(),
    idempotency: inMemoryIdempotencyStore({ clock }),
    clock,
    ids: sequentialIds("student"),
    onDefect: (defect) => defects.push(defect),
  });
  const handler = httpHandler(app, {
    messageIds: sequentialIds("request").next,
    authenticator: tokenAuthenticator({ "registrar-token": registrar, "teacher-token": teacher }),
  });
  /** POST as the registrar unless other headers are given. */
  const post = async (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer registrar-token" }) => {
    const response = await handler(
      new Request(`http://school.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, handler, post, eventStore, clock, defects };
}
