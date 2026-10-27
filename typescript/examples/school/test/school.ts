import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/event-store-memory";
import { httpHandler } from "@projected/http";
import { fixedClock, sequentialIds } from "@projected/testing";
import { inMemoryStudentDirectory } from "../src/infrastructure/adapter/driven/directory/in-memory-student-directory.js";
import { composeSchool } from "../src/infrastructure/config/school.js";

/** The real composition, with deterministic time and ids, served by the real HTTP handler. */
export function testSchool() {
  const clock = fixedClock("2023-10-01T09:00:00.000Z");
  const eventStore = inMemoryEventStore({ clock, ids: sequentialIds("event") });
  const app = composeSchool({
    eventStore,
    checkpoints: inMemoryCheckpointStore(),
    directory: inMemoryStudentDirectory(),
    clock,
    ids: sequentialIds("student"),
  });
  const handler = httpHandler(app, { messageIds: sequentialIds("request").next });
  const post = async (path: string, body: unknown) => {
    const response = await handler(
      new Request(`http://school.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, handler, post, eventStore, clock };
}
