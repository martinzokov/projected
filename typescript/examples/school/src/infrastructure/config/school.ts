import {
  aggregateRepository,
  createApplication,
  type CheckpointStore,
  type Clock,
  type EventStore,
  type IdGenerator,
} from "@projected/application";
import { Student } from "../../domain/student/student.js";
import { schoolContracts } from "../../application/port/driving/index.js";
import type { StudentDirectory } from "../../application/port/driven/student-directory.js";
import { enlistStudentV1, enlistStudentV2 } from "../../application/usecase/enlist-student.js";
import { enlistedStudentsOnJoiningDate } from "../../application/usecase/enlisted-students-on-joining-date.js";
import { reportStudentLastnameChange } from "../../application/usecase/report-student-lastname-change.js";
import { studentDirectoryProjection } from "../../application/usecase/student-directory-projection.js";
import { studentProfile } from "../../application/usecase/student-profile.js";
import { withdrawStudent } from "../../application/usecase/withdraw-student.js";

/** Everything the school needs from the outside world. Swap any of it without touching a use case. */
export interface SchoolInfrastructure {
  readonly eventStore: EventStore;
  readonly checkpoints: CheckpointStore;
  readonly directory: StudentDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onDefect?: (defect: Error) => void;
}

/**
 * The composition root: binds every contract to its handler. Leaving a contract out, or binding
 * a handler to the wrong contract, does not compile.
 */
export function composeSchool(infrastructure: SchoolInfrastructure) {
  const { eventStore, checkpoints, directory, clock, ids } = infrastructure;
  const students = aggregateRepository(Student, eventStore);

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
    eventHandling: { handlers: [studentDirectoryProjection({ directory })], store: eventStore, checkpoints },
    ...(infrastructure.onDefect === undefined ? {} : { onDefect: infrastructure.onDefect }),
  });
}
