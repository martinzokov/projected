import { defineEvent, z } from "@projected/domain/event-sourced";

/** Facts about a student, in the past tense. Persisted forever: never change a published schema. */

export const StudentEnlisted = defineEvent("StudentEnlisted", {
  schema: z.object({
    studentId: z.string(),
    firstname: z.string(),
    lastname: z.string(),
    joiningDate: z.iso.date(),
  }),
});

export const StudentLastnameChanged = defineEvent("StudentLastnameChanged", {
  schema: z.object({
    studentId: z.string(),
    previousLastname: z.string(),
    newLastname: z.string(),
    reportedAt: z.iso.datetime(),
  }),
});

export const StudentWithdrawn = defineEvent("StudentWithdrawn", {
  schema: z.object({
    studentId: z.string(),
    leavingDate: z.iso.date(),
  }),
});
