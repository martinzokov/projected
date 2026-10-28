import { defineContracts } from "@projected/application/state-based";
import { EnlistStudentV1, EnlistStudentV2 } from "./enlist-student.js";
import { EnlistedStudentsOnJoiningDate } from "./enlisted-students-on-joining-date.js";
import { ReportStudentLastnameChange } from "./report-student-lastname-change.js";
import { StudentProfile } from "./student-profile.js";
import { WithdrawStudent } from "./withdraw-student.js";

/**
 * Everything the school offers. HTTP endpoints, the OpenAPI document, typed clients and the
 * contract lock are all derived from this list.
 */
export const schoolContracts = defineContracts({
  name: "school",
  description: "Enlists students and answers questions about them.",
  // Staff only, by default. Operations that change enrolment require `students:manage`.
  access: "authenticated",
  commands: [EnlistStudentV1, EnlistStudentV2, ReportStudentLastnameChange, WithdrawStudent],
  queries: [EnlistedStudentsOnJoiningDate, StudentProfile],
});

export {
  EnlistStudentV1,
  EnlistStudentV2,
  EnlistedStudentsOnJoiningDate,
  ReportStudentLastnameChange,
  StudentProfile,
  WithdrawStudent,
};
