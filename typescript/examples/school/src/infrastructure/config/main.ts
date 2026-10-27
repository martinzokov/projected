import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/event-store-memory";
import { httpHandler } from "@projected/http";
import { serve } from "@projected/http/node";
import { randomIds, systemClock } from "@projected/runtime";
import { inMemoryStudentDirectory } from "../adapter/driven/directory/in-memory-student-directory.js";
import { composeSchool } from "./school.js";

const clock = systemClock();
const school = composeSchool({
  eventStore: inMemoryEventStore({ clock }),
  checkpoints: inMemoryCheckpointStore(),
  directory: inMemoryStudentDirectory(),
  clock,
  ids: randomIds(),
  onDefect: (defect) => console.error("defect", defect),
});

const server = await serve(httpHandler(school), { port: Number(process.env.PORT ?? 3000) });
console.log(`school is listening on ${server.url} — OpenAPI document at ${server.url}/openapi.json`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
