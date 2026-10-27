import { describe, it } from "vitest";
import { given } from "@projected/testing";
import { LeavingBeforeJoining, StudentAlreadyEnlisted, StudentNotEnlisted } from "../../src/domain/student/errors.js";
import { StudentEnlisted, StudentLastnameChanged, StudentWithdrawn } from "../../src/domain/student/events.js";
import { Student, enlist, reportLastnameChange, withdraw } from "../../src/domain/student/student.js";

const bruce = { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" };
const enlisted = StudentEnlisted(bruce);

describe("enlisting", () => {
  it("enlists a new student", () => {
    given(Student).when((state) => enlist(state, bruce)).thenEvents(StudentEnlisted(bruce));
  });

  it("refuses to enlist the same student twice", () => {
    given(Student, [enlisted])
      .when((state) => enlist(state, bruce))
      .thenRejectsWith(StudentAlreadyEnlisted, { studentId: "s-1" });
  });
});

describe("reporting a lastname change", () => {
  const report = { studentId: "s-1", newLastname: "Kent", reportedAt: "2023-10-01T09:00:00.000Z" };

  it("records the change with the previous name", () => {
    given(Student, [enlisted])
      .when((state) => reportLastnameChange(state, report))
      .thenEvents(StudentLastnameChanged({ ...report, previousLastname: "Wayne" }));
  });

  it("records nothing when the name is unchanged", () => {
    given(Student, [enlisted])
      .when((state) => reportLastnameChange(state, { ...report, newLastname: "Wayne" }))
      .thenNothingHappens();
  });

  it("refuses changes for students who are not enlisted", () => {
    given(Student, [enlisted, StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" })])
      .when((state) => reportLastnameChange(state, report))
      .thenRejectsWith(StudentNotEnlisted);
  });
});

describe("withdrawing", () => {
  it("withdraws an enlisted student", () => {
    given(Student, [enlisted])
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2024-06-30" }))
      .thenEvents(StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" }));
  });

  it("treats withdrawing twice as already done", () => {
    given(Student, [enlisted, StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" })])
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2024-07-01" }))
      .thenNothingHappens();
  });

  it("refuses a leaving date before the joining date", () => {
    given(Student, [enlisted])
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2023-01-01" }))
      .thenRejectsWith(LeavingBeforeJoining, { joiningDate: "2023-09-22", leavingDate: "2023-01-01" });
  });

  it("refuses to withdraw someone who never enlisted", () => {
    given(Student)
      .when((state) => withdraw(state, { studentId: "s-9", leavingDate: "2024-06-30" }))
      .thenRejectsWith(StudentNotEnlisted);
  });
});
