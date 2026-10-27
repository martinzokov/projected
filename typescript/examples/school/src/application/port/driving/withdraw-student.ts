import { defineCommand, z } from "@projected/application";
import { LeavingBeforeJoining, StudentNotEnlisted } from "../../../domain/student/errors.js";

export const WithdrawStudent = defineCommand({
  type: "withdraw-student",
  summary: "Record that a student leaves the school",
  description: "The student's record is kept; they no longer appear among enlisted students.",
  access: { permissions: ["students:manage"] },
  input: z.object({ studentId: z.string(), leavingDate: z.iso.date() }),
  output: z.object({ withdrawn: z.boolean() }),
  errors: [StudentNotEnlisted, LeavingBeforeJoining],
});
