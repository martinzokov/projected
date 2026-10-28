import { defineError, z } from "@projected/domain/state-based";

/** Business rules a request can break. Each is an outcome the caller can act on. */

export class StudentAlreadyEnlisted extends defineError("StudentAlreadyEnlisted", {
  schema: z.object({ studentId: z.string() }),
  message: ({ studentId }) => `Student ${studentId} is already enlisted`,
  description: "A student with this id has already been enlisted.",
}) {}

export class StudentNotEnlisted extends defineError("StudentNotEnlisted", {
  schema: z.object({ studentId: z.string() }),
  message: ({ studentId }) => `No enlisted student has id ${studentId}`,
  description: "The student was never enlisted, or has withdrawn.",
}) {}

export class LeavingBeforeJoining extends defineError("LeavingBeforeJoining", {
  schema: z.object({ joiningDate: z.iso.date(), leavingDate: z.iso.date() }),
  message: ({ joiningDate, leavingDate }) => `Cannot leave on ${leavingDate}, before joining on ${joiningDate}`,
}) {}
