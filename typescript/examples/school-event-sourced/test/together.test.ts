import { describe, expect, it } from "vitest";
import { Result, defineEventHandler } from "@projected/application/event-sourced";
import { commandQueue, consumeCommands, consumeEvents, eventRelay, inMemoryTransport } from "@projected/messaging";
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryIdempotencyStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { fixedClock, principal, sequentialIds } from "@projected/testing/event-sourced";
import { EnlistStudentV2 } from "../src/application/port/driving/enlist-student.js";
import { schoolContracts } from "../src/application/port/driving/index.js";
import { StudentEnlisted } from "../src/domain/student/events.js";
import { composeSchool } from "../src/infrastructure/config/school.js";

/**
 * Three services in one process, talking through one in-memory transport as they would through
 * Kafka or NATS: admissions queues an enlistment, the school runs it and publishes what happened,
 * and attendance keeps its register from the school's events.
 */
describe("services in one process", () => {
  it("queue a command for the school and follow the events it publishes, with no broker", async () => {
    const bus = inMemoryTransport();
    const clock = fixedClock("2023-10-01T09:00:00.000Z");
    const school = composeSchool({
      eventStore: inMemoryEventStore({ clock, ids: sequentialIds("event") }),
      checkpoints: inMemoryCheckpointStore(),
      documents: inMemoryDocumentStore(),
      idempotency: inMemoryIdempotencyStore({ clock }),
      clock,
      ids: sequentialIds("student"),
      eventHandlers: [eventRelay(bus, { name: "school-events", topic: "school.events" })],
    });
    // Consumers first: an acknowledged publish waits for the groups subscribed when it is sent.
    await consumeCommands(school, bus, { topic: "school.commands", principal: principal("svc-admissions", ["students:manage"]) });
    const register = new Map<string, string>();
    const attendance = defineEventHandler({
      name: "attendance-register",
      events: [StudentEnlisted],
      handle: {
        StudentEnlisted: ({ data }) => {
          register.set(data.studentId, `${data.firstname} ${data.lastname}`);
          return Result.ok(undefined);
        },
      },
    });
    await consumeEvents(attendance, bus, { topic: "school.events" });
    const admissions = commandQueue(schoolContracts, bus, { topic: "school.commands", ids: sequentialIds("admission") });

    const queued = await admissions.enqueue(EnlistStudentV2, { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" });
    // The relay runs in the background poller in main.ts; here, once, by hand.
    const relayed = await school.catchUp();

    expect(queued.isOk()).toBe(true);
    expect(relayed.isOk()).toBe(true);
    expect(register.get("s-1")).toBe("Bruce Wayne");
  });
});
