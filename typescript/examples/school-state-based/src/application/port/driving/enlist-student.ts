import { defineCommand, z } from "@projected/application/state-based";
import { StudentAlreadyEnlisted } from "../../../domain/student/errors.js";

const Student = {
  firstname: z.string().trim().min(1),
  lastname: z.string().trim().min(1),
  joiningDate: z.iso.date(),
};

/** Version 1: the school assigns the student id. Kept for existing clients. */
export const EnlistStudentV1 = defineCommand({
  type: "enlist-student",
  version: 1,
  summary: "Enlist a new student",
  description: "Superseded by version 2, which lets the caller choose the id so that retries are safe.",
  deprecated: true,
  access: { permissions: ["students:manage"] },
  input: z.object(Student),
  output: z.object({ studentId: z.string() }),
});

/** Version 2: the caller chooses the id, so retrying the same enlistment cannot create two students. */
export const EnlistStudentV2 = defineCommand({
  type: "enlist-student",
  version: 2,
  summary: "Enlist a new student",
  access: { permissions: ["students:manage"] },
  input: z.object({ studentId: z.string().min(1), ...Student }),
  output: z.object({ studentId: z.string() }),
  errors: [StudentAlreadyEnlisted],
});
