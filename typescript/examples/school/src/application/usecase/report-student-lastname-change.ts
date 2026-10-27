import type { AggregateRepository, Clock, CommandHandler } from "@projected/application";
import { Student, reportLastnameChange } from "../../domain/student/student.js";
import type { ReportStudentLastnameChange } from "../port/driving/report-student-lastname-change.js";

export const reportStudentLastnameChange =
  (deps: { students: AggregateRepository<typeof Student>; clock: Clock }): CommandHandler<typeof ReportStudentLastnameChange> =>
  async ({ studentId, newLastname }, context) => {
    // The decision is pure, so the use case reads the clock and passes the time in.
    const reportedAt = deps.clock.now().toISOString();
    const changed = await deps.students.execute(
      studentId,
      (state) => reportLastnameChange(state, { studentId, newLastname, reportedAt }),
      context,
    );
    return changed.map(({ events }) => ({ changed: events.length > 0 }));
  };
