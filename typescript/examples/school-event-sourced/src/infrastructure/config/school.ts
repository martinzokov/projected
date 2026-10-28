import {
  aggregateRepository,
  createApplication,
  type CheckpointStore,
  type Clock,
  type DocumentStore,
  type EventHandler,
  type EventStore,
  type IdGenerator,
  type IdempotencyStore,
  type ReadinessCheck,
  type Telemetry,
} from "@projected/application/event-sourced";
import { Student } from "../../domain/student/student.js";
import { schoolContracts } from "../../application/port/driving/index.js";
import { enlistStudentV1, enlistStudentV2 } from "../../application/usecase/enlist-student.js";
import { enlistedStudentsOnJoiningDate } from "../../application/usecase/enlisted-students-on-joining-date.js";
import { reportStudentLastnameChange } from "../../application/usecase/report-student-lastname-change.js";
import { studentDirectoryProjection } from "../../application/usecase/student-directory-projection.js";
import { studentProfile } from "../../application/usecase/student-profile.js";
import { withdrawStudent } from "../../application/usecase/withdraw-student.js";
import { documentStudentDirectory } from "../adapter/driven/directory/document-student-directory.js";

/** Everything the school needs from the outside world. Swap any of it without touching a use case. */
export interface SchoolInfrastructure {
  readonly eventStore: EventStore;
  readonly checkpoints: CheckpointStore;
  /** Holds the student directory read model. */
  readonly documents: DocumentStore;
  /** Remembers command outcomes so retried commands never run twice. */
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telemetry?: Telemetry;
  /** Further event handlers, e.g. a relay publishing events to a broker. */
  readonly eventHandlers?: readonly EventHandler[];
  /** What the school cannot serve without, reported by `GET /health/ready`. */
  readonly readiness?: readonly ReadinessCheck[];
  readonly onDefect?: (defect: Error) => void;
  /** An event handler the request path could not bring up to date; the poller retries it. */
  readonly onEventHandlingError?: (error: Error, handler: string) => void;
}

/**
 * The composition root: binds every contract to its handler. Leaving a contract out, or binding
 * a handler to the wrong contract, does not compile.
 */
export function composeSchool(infrastructure: SchoolInfrastructure) {
  const { eventStore, checkpoints, documents, idempotency, clock, ids, telemetry } = infrastructure;
  const students = aggregateRepository(Student, eventStore, telemetry === undefined ? {} : { telemetry });
  const directory = documentStudentDirectory(documents);
  const studentDirectory = studentDirectoryProjection({ directory });

  return createApplication(schoolContracts, {
    ids,
    commands: {
      "enlist-student@1": enlistStudentV1({ students, ids }),
      "enlist-student@2": enlistStudentV2({ students }),
      "report-student-lastname-change@1": reportStudentLastnameChange({ students, clock }),
      "withdraw-student@1": withdrawStudent({ students }),
    },
    queries: {
      "enlisted-students-on-joining-date@1": enlistedStudentsOnJoiningDate({ directory }),
      "student-profile@1": studentProfile({ students }),
    },
    eventHandling: {
      handlers: [studentDirectory, ...(infrastructure.eventHandlers ?? [])],
      store: eventStore,
      checkpoints,
      // Callers read the directory right after enlisting, so it catches up with every command.
      // Relays to a broker run in the background (main.ts), off the request path.
      inline: [studentDirectory.name],
    },
    idempotency: { store: idempotency },
    readiness: infrastructure.readiness ?? [],
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(infrastructure.onDefect === undefined ? {} : { onDefect: infrastructure.onDefect }),
    ...(infrastructure.onEventHandlingError === undefined ? {} : { onEventHandlingError: infrastructure.onEventHandlingError }),
  });
}
