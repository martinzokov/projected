import { Result, changeTo, defineAggregate, noChange, z, type Decision, type StateOf } from "@projected/domain/state-based";
import { LeavingBeforeJoining, StudentAlreadyEnlisted, StudentNotEnlisted } from "./errors.js";
import { StudentEnlisted, StudentLastnameChanged, StudentWithdrawn } from "./events.js";

/**
 * A student, stored as its current state. A withdrawn student keeps their record. The events are
 * what other parts of the system hear about — here, the student directory read model.
 */
export const Student = defineAggregate({
  name: "student",
  schema: z.object({
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    joiningDate: z.iso.date(),
    status: z.enum(["enlisted", "withdrawn"]),
  }),
  events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],
});

/** A student's state. `undefined` stands for "no such student". */
export type StudentState = StateOf<typeof Student>;

/**
 * Decisions: pure functions from the current state and a request to the next state and the
 * events announcing it, or the business rule that refuses them. No I/O, no clock, no randomness
 * — anything like that arrives as input.
 */

export function enlist(
  state: StudentState | undefined,
  input: { studentId: string; firstname: string; lastname: string; joiningDate: string },
): Decision<typeof Student, StudentAlreadyEnlisted> {
  if (state !== undefined) return Result.err(new StudentAlreadyEnlisted({ studentId: input.studentId }));
  const { firstname, lastname, joiningDate } = input;
  return Result.ok(changeTo({ firstname, lastname, joiningDate, status: "enlisted" }, StudentEnlisted(input)));
}

export function reportLastnameChange(
  state: StudentState | undefined,
  input: { studentId: string; newLastname: string; reportedAt: string },
): Decision<typeof Student, StudentNotEnlisted> {
  if (state?.status !== "enlisted") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  // Reporting the name we already have changes nothing: accept it, store nothing.
  if (state.lastname === input.newLastname) return Result.ok(noChange());
  return Result.ok(
    changeTo({ ...state, lastname: input.newLastname }, StudentLastnameChanged({ ...input, previousLastname: state.lastname })),
  );
}

export function withdraw(
  state: StudentState | undefined,
  input: { studentId: string; leavingDate: string },
): Decision<typeof Student, StudentNotEnlisted | LeavingBeforeJoining> {
  if (state === undefined) return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  if (state.status === "withdrawn") return Result.ok(noChange());
  if (input.leavingDate < state.joiningDate) {
    return Result.err(new LeavingBeforeJoining({ joiningDate: state.joiningDate, leavingDate: input.leavingDate }));
  }
  return Result.ok(changeTo({ ...state, status: "withdrawn" }, StudentWithdrawn(input)));
}
