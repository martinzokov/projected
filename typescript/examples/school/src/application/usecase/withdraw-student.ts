import type { AggregateRepository, CommandHandler } from "@projected/application";
import { Student, withdraw } from "../../domain/student/student.js";
import type { WithdrawStudent } from "../port/driving/withdraw-student.js";

export const withdrawStudent =
  (deps: { students: AggregateRepository<typeof Student> }): CommandHandler<typeof WithdrawStudent> =>
  async (input, context) =>
    (await deps.students.execute(input.studentId, (state) => withdraw(state, input), context)).map(({ events }) => ({
      withdrawn: events.length > 0,
    }));
