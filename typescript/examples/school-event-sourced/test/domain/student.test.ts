import { describe, it } from "vitest";
import { z } from "@projected/application/event-sourced";
import { everyHistoryFolds, forAll, fromSchema, given } from "@projected/testing/event-sourced";
import { EnlistStudentV2 } from "../../src/application/port/driving/enlist-student.js";
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

  it("applies the change, so reporting the new name again changes nothing", () => {
    given(Student, [enlisted, StudentLastnameChanged({ ...report, previousLastname: "Wayne" })])
      .when((state) => reportLastnameChange(state, report))
      .thenNothingHappens();
  });

  it("records nothing when the name is unchanged", () => {
    given(Student, [enlisted])
      .when((state) => reportLastnameChange(state, { ...report, newLastname: "Wayne" }))
      .thenNothingHappens();
  });

  it("refuses changes for students who are not enlisted", () => {
    given(Student, [enlisted, StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" })])
      .when((state) => reportLastnameChange(state, report))
      .thenRejectsWith(StudentNotEnlisted, { studentId: "s-1" });
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

  it("lets a student leave on the day they joined", () => {
    given(Student, [enlisted])
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2023-09-22" }))
      .thenEvents(StudentWithdrawn({ studentId: "s-1", leavingDate: "2023-09-22" }));
  });

  it("refuses a leaving date before the joining date", () => {
    given(Student, [enlisted])
      .when((state) => withdraw(state, { studentId: "s-1", leavingDate: "2023-01-01" }))
      .thenRejectsWith(LeavingBeforeJoining, { joiningDate: "2023-09-22", leavingDate: "2023-01-01" });
  });

  it("refuses to withdraw someone who never enlisted", () => {
    given(Student)
      .when((state) => withdraw(state, { studentId: "s-9", leavingDate: "2024-06-30" }))
      .thenRejectsWith(StudentNotEnlisted, { studentId: "s-9" });
  });
});

describe("properties", () => {
  const Report = z.object({ newLastname: z.string().trim().min(1), reportedAt: z.iso.datetime() });

  it("folds any history of student events, however unlikely its order", () => {
    everyHistoryFolds(Student);
  });

  it("never changes a withdrawn student's name, whatever is reported", () => {
    const history = [enlisted, StudentWithdrawn({ studentId: "s-1", leavingDate: "2024-06-30" })];

    forAll([fromSchema(Report)], (report) => {
      given(Student, history)
        .when((state) => reportLastnameChange(state, { studentId: "s-1", ...report }))
        .thenRejectsWith(StudentNotEnlisted);
    });
  });

  it("enlists anyone the contract accepts, exactly once", () => {
    forAll([fromSchema(EnlistStudentV2.input)], (input) => {
      given(Student).when((state) => enlist(state, input)).thenEvents(StudentEnlisted(input));
      given(Student, [StudentEnlisted(input)]).when((state) => enlist(state, input)).thenRejectsWith(StudentAlreadyEnlisted);
    });
  });
});
