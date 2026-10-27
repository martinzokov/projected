import { Result, defineAggregate, type Decision } from "@projected/domain";
import { LeavingBeforeJoining, StudentAlreadyEnlisted, StudentNotEnlisted } from "./errors.js";
import { StudentEnlisted, StudentLastnameChanged, StudentWithdrawn } from "./events.js";

export type StudentState =
  | { readonly status: "unknown" }
  | {
      readonly status: "enlisted" | "withdrawn";
      readonly firstname: string;
      readonly lastname: string;
      readonly joiningDate: string;
    };

export const Student = defineAggregate({
  name: "student",
  initialState: (): StudentState => ({ status: "unknown" }),
  events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],
  evolve: {
    StudentEnlisted: (_state, { firstname, lastname, joiningDate }) => ({ status: "enlisted", firstname, lastname, joiningDate }),
    StudentLastnameChanged: (state, { newLastname }) =>
      state.status === "unknown" ? state : { ...state, lastname: newLastname },
    StudentWithdrawn: (state) => (state.status === "unknown" ? state : { ...state, status: "withdrawn" }),
  },
});

/**
 * Decisions: pure functions from the current state and a request to the events that follow,
 * or the business rule that refuses them. No I/O, no clock, no randomness — anything like that
 * arrives as input.
 */

export function enlist(
  state: StudentState,
  input: { studentId: string; firstname: string; lastname: string; joiningDate: string },
): Decision<typeof Student, StudentAlreadyEnlisted> {
  if (state.status !== "unknown") return Result.err(new StudentAlreadyEnlisted({ studentId: input.studentId }));
  return Result.ok([StudentEnlisted(input)]);
}

export function reportLastnameChange(
  state: StudentState,
  input: { studentId: string; newLastname: string; reportedAt: string },
): Decision<typeof Student, StudentNotEnlisted> {
  if (state.status !== "enlisted") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  // Reporting the name we already have changes nothing: accept it, record nothing.
  if (state.lastname === input.newLastname) return Result.ok([]);
  return Result.ok([StudentLastnameChanged({ ...input, previousLastname: state.lastname })]);
}

export function withdraw(
  state: StudentState,
  input: { studentId: string; leavingDate: string },
): Decision<typeof Student, StudentNotEnlisted | LeavingBeforeJoining> {
  if (state.status === "unknown") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  if (state.status === "withdrawn") return Result.ok([]);
  if (input.leavingDate < state.joiningDate) {
    return Result.err(new LeavingBeforeJoining({ joiningDate: state.joiningDate, leavingDate: input.leavingDate }));
  }
  return Result.ok([StudentWithdrawn(input)]);
}
