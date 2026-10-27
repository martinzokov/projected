import { defineQuery, z } from "@projected/application";

/** A missing student is a normal answer (`student: null`), not a protocol error. */
export const StudentProfile = defineQuery({
  type: "student-profile",
  summary: "Look up one student",
  input: z.object({ studentId: z.string() }),
  output: z.object({
    student: z
      .object({
        studentId: z.string(),
        firstname: z.string(),
        lastname: z.string(),
        joiningDate: z.iso.date(),
        status: z.enum(["enlisted", "withdrawn"]),
      })
      .nullable(),
  }),
});
