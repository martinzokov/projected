import { panic, type AggregateRepository, type CommandHandler, type IdGenerator } from "@projected/application";
import { StudentAlreadyEnlisted } from "../../domain/student/errors.js";
import { Student, enlist } from "../../domain/student/student.js";
import type { EnlistStudentV1, EnlistStudentV2 } from "../port/driving/enlist-student.js";

export const enlistStudentV1 =
  (deps: { students: AggregateRepository<typeof Student>; ids: IdGenerator }): CommandHandler<typeof EnlistStudentV1> =>
  async (input, context) => {
    const studentId = deps.ids.next();
    const enlisted = await deps.students.execute(studentId, (state) => enlist(state, { studentId, ...input }), context);
    return enlisted
      .map(() => ({ studentId }))
      .mapError((error) =>
        // Version 1 declares no business errors: a freshly generated id cannot belong to an
        // enlisted student. If it does, the id generator is broken — a defect, not an outcome.
        StudentAlreadyEnlisted.is(error) ? panic(`Generated student id ${studentId} is already taken`, error) : error,
      );
  };

export const enlistStudentV2 =
  (deps: { students: AggregateRepository<typeof Student> }): CommandHandler<typeof EnlistStudentV2> =>
  async ({ studentId, ...input }, context) =>
    (await deps.students.execute(studentId, (state) => enlist(state, { studentId, ...input }), context)).map(() => ({
      studentId,
    }));
