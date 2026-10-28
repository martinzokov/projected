import { defineCommand, z } from "@projected/application/state-based";
import { StudentNotEnlisted } from "../../../domain/student/errors.js";

export const ReportStudentLastnameChange = defineCommand({
  type: "report-student-lastname-change",
  summary: "Report that a student's lastname has changed",
  input: z.object({ studentId: z.string(), newLastname: z.string().trim().min(1) }),
  output: z.object({ changed: z.boolean() }),
  errors: [StudentNotEnlisted],
});
