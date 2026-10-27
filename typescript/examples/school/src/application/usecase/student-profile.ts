import type { AggregateRepository, QueryHandler } from "@projected/application";
import type { Student } from "../../domain/student/student.js";
import type { StudentProfile } from "../port/driving/student-profile.js";

/** Answers from the aggregate itself: always consistent with the last command. */
export const studentProfile =
  (deps: { students: AggregateRepository<typeof Student> }): QueryHandler<typeof StudentProfile> =>
  async ({ studentId }) =>
    (await deps.students.load(studentId)).map(({ state }) => ({
      student: state.status === "unknown" ? null : { studentId, ...state },
    }));
