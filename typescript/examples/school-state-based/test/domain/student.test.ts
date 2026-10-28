import { describe, it } from "vitest";
import { given } from "@projected/testing/state-based";
import { LeavingBeforeJoining, StudentAlreadyEnlisted, StudentNotEnlisted } from "../../src/domain/student/errors.js";
import { StudentEnlisted, StudentLastnameChanged, StudentWithdrawn } from "../../src/domain/student/events.js";
import { Student, enlist, reportLastnameChange, withdraw, type StudentState } from "../../src/domain/student/student.js";

const bruce = { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" };
const enlisted: StudentState = { firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22", status: "enlisted" };
const withdrawn: StudentState = { ...enlisted, status: "withdrawn" };

describe("enlisting", () => {
  it("enlists a new student", () => {
    given(Student)
      .when((state) => enlist(state, bruce))
      .thenChangesTo(enlisted, StudentEnlisted(bruce));
  });

  it("refuses to enlist the same student twice", () => {
    given(Student, enlisted)
      .when((state) => enlist(state, bruce))
      .thenRejectsWith(StudentAlreadyEnlisted, { studentId: "s-1" });
  });
});

describe("reporting a lastname change", () => {
  const report = { studentId: "s-1", newLastname: "Kent", reportedAt: "2023-10-01T09:00:00.000Z" };

  it("changes the name and announces the previous one", () => {
    given(Student, enlisted)
      .when((state) => reportLastnameChange(state, report))
      .thenChangesTo({ ...enlisted, lastname: "Kent" }, StudentLastnameChanged({ ...report, previousLastname: "Wayne" }));
  });

  it("changes nothing when the name is unchanged", () => {
    given(Student, enlisted)
      .when((state) => reportLastnameChange(state, { ...report, newLastname: "Wayne" }))
      .thenNothingHappens();
  });

  it("refuses changes for students who are not enlisted", () => {
    given(Student, withdrawn)
      .when((state) => reportLastnameChange(state, report))
      .thenRejectsWith(StudentNotEnlisted);
  });
});

describe("withdrawing", () => {
  it("withdraws an enlisted student and keeps their record", () => {
    given(Student, enlisted)
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2024-06-30" }))
      .thenChangesTo(withdrawn, StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" }));
  });

  it("treats withdrawing twice as already done", () => {
    given(Student, withdrawn)
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2024-07-01" }))
      .thenNothingHappens();
  });

  it("refuses a leaving date before the joining date", () => {
    given(Student, enlisted)
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2023-01-01" }))
      .thenRejectsWith(LeavingBeforeJoining, { joiningDate: "2023-09-22", leavingDate: "2023-01-01" });
  });

  it("refuses to withdraw someone who never enlisted", () => {
    given(Student)
      .when((state) => withdraw(state, { studentId: "s-9", leavingDate: "2024-06-30" }))
      .thenRejectsWith(StudentNotEnlisted);
  });
});
