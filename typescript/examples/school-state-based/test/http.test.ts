import { describe, expect, it } from "vitest";
import { testSchool } from "./school.js";

const asTeacher = { authorization: "Bearer teacher-token" };

/** The examples from "It's time to put REST to rest", against the real HTTP adapter. */
describe("school over HTTP", () => {
  const bruce = { firstname: "Bruce", lastname: "Wayne", "joiningDate": "2023-09-22" };

  it("enlists a student and finds them by joining date", async () => {
    const { post } = testSchool();

    const enlisted = await post("/commands/enlist-student/version/1", bruce);
    const found = await post("/queries/enlisted-students-on-joining-date/version/1", { date: "2023-09-22" });

    expect(enlisted).toEqual({ status: 200, body: { status: "ok", value: { studentId: "student-1" } } });
    expect(found.body).toEqual({
      status: "ok",
      value: { students: [{ studentId: "student-1", firstname: "Bruce", lastname: "Wayne" }] },
    });
  });

  it("reports a lastname change, which the directory reflects", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/1", bruce);

    const reported = await post("/commands/report-student-lastname-change/version/1", { studentId: "student-1", newLastname: "Kent" });
    const found = await post("/queries/enlisted-students-on-joining-date/version/1", { date: "2023-09-22" });

    expect(reported.body).toEqual({ status: "ok", value: { changed: true } });
    expect(found.body).toMatchObject({ value: { students: [{ lastname: "Kent" }] } });
  });

  it("runs a batch of different commands in one request", async () => {
    const { post } = testSchool();

    const batch = await post("/commands", {
      commands: [
        { type: "enlist-student", version: 1, data: bruce },
        { type: "report-student-lastname-change", version: 1, data: { studentId: "student-1", newLastname: "Kent" } },
      ],
    });

    expect(batch.body).toEqual({
      results: [
        { status: "ok", value: { studentId: "student-1" } },
        { status: "ok", value: { changed: true } },
      ],
    });
  });

  it("answers a question about a missing student with 200 and null", async () => {
    const { post } = testSchool();

    const profile = await post("/queries/student-profile/version/1", { studentId: "nobody" });

    expect(profile).toEqual({ status: 200, body: { status: "ok", value: { student: null } } });
  });

  it("returns broken business rules as 200 with a typed error", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/2", { studentId: "s-42", ...bruce });

    const again = await post("/commands/enlist-student/version/2", { studentId: "s-42", ...bruce });

    expect(again).toEqual({
      status: 200,
      body: {
        status: "error",
        error: { type: "StudentAlreadyEnlisted", message: "Student s-42 is already enlisted", data: { studentId: "s-42" } },
      },
    });
  });

  it("serves both versions of enlist-student side by side", async () => {
    const { post } = testSchool();

    const v1 = await post("/commands/enlist-student/version/1", bruce);
    const v2 = await post("/commands/enlist-student/version/2", { studentId: "s-2", firstname: "Clark", lastname: "Kent", joiningDate: "2023-09-22" });
    const found = await post("/queries/enlisted-students-on-joining-date/version/1", { date: "2023-09-22" });

    expect([v1.body.status, v2.body.status]).toEqual(["ok", "ok"]);
    expect((found.body.value as { students: unknown[] }).students).toHaveLength(2);
  });

  it("keeps the record of a withdrawn student but stops listing them", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/2", { studentId: "s-1", ...bruce });

    await post("/commands/withdraw-student/version/1", { studentId: "s-1", leavingDate: "2024-06-30" });
    const found = await post("/queries/enlisted-students-on-joining-date/version/1", { date: "2023-09-22" });
    const profile = await post("/queries/student-profile/version/1", { studentId: "s-1" });

    expect(found.body).toEqual({ status: "ok", value: { students: [] } });
    expect(profile.body).toMatchObject({ value: { student: { status: "withdrawn", lastname: "Wayne" } } });
  });

  it("reports a lastname that is already the student's as no change", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/1", bruce);

    const reported = await post("/commands/report-student-lastname-change/version/1", { studentId: "student-1", newLastname: "Wayne" });

    expect(reported.body).toEqual({ status: "ok", value: { changed: false } });
  });

  it("withdraws a student once, and reports a repeat as no change", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/2", { studentId: "s-1", ...bruce });

    const first = await post("/commands/withdraw-student/version/1", { studentId: "s-1", leavingDate: "2024-06-30" });
    const again = await post("/commands/withdraw-student/version/1", { studentId: "s-1", leavingDate: "2024-07-01" });

    expect([first.body, again.body]).toEqual([
      { status: "ok", value: { withdrawn: true } },
      { status: "ok", value: { withdrawn: false } },
    ]);
  });

  it("explains a refused withdrawal with the rule it broke", async () => {
    const { post } = testSchool();
    await post("/commands/enlist-student/version/2", { studentId: "s-1", ...bruce });

    const unknown = await post("/commands/withdraw-student/version/1", { studentId: "s-9", leavingDate: "2024-06-30" });
    const early = await post("/commands/withdraw-student/version/1", { studentId: "s-1", leavingDate: "2023-01-01" });

    expect([unknown.body, early.body]).toEqual([
      { status: "error", error: { type: "StudentNotEnlisted", message: "No enlisted student has id s-9", data: { studentId: "s-9" } } },
      {
        status: "error",
        error: {
          type: "LeavingBeforeJoining",
          message: "Cannot leave on 2023-01-01, before joining on 2023-09-22",
          data: { joiningDate: "2023-09-22", leavingDate: "2023-01-01" },
        },
      },
    ]);
  });

  it("treats a generated id that is already taken as a defect, not an outcome", async () => {
    const { post, defects } = testSchool();
    await post("/commands/enlist-student/version/2", { studentId: "student-1", ...bruce });

    const collided = await post("/commands/enlist-student/version/1", bruce);

    expect(collided.status).toBe(500);
    expect(defects.map((defect) => defect.message)).toEqual([expect.stringContaining("Generated student id student-1 is already taken")]);
  });

  it("uses protocol status codes only for protocol problems", async () => {
    const { post } = testSchool();

    const invalid = await post("/commands/enlist-student/version/1", { firstname: "" });
    const unknown = await post("/commands/enrol-student/version/1", bruce);

    expect([invalid.status, unknown.status]).toEqual([400, 404]);
  });

  it("stores the student's state and announces each change with the request's correlation", async () => {
    const { post, stateStore } = testSchool();
    await post("/commands/enlist-student/version/1", bruce);

    await post("/commands/report-student-lastname-change/version/1", { studentId: "student-1", newLastname: "Kent" });

    expect(stateStore.stateOf("student-student-1")?.data).toEqual({ ...bruce, lastname: "Kent", status: "enlisted" });
    expect(stateStore.eventsOf("student-student-1").map((event) => [event.type, event.data])).toEqual([
      ["StudentEnlisted", { studentId: "student-1", ...bruce }],
      [
        "StudentLastnameChanged",
        { studentId: "student-1", previousLastname: "Wayne", newLastname: "Kent", reportedAt: "2023-10-01T09:00:00.000Z" },
      ],
    ]);
    expect(stateStore.all[1]?.metadata).toEqual({ correlationId: "request-2", causationId: "request-2", principalId: "u-registrar" });
  });
});

describe("school access rules", () => {
  const bruce = { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" };

  it("lets any member of staff look students up", async () => {
    const { post } = testSchool();

    const profile = await post("/queries/student-profile/version/1", { studentId: "s-1" }, asTeacher);

    expect(profile.status).toBe(200);
  });

  it("keeps enrolment changes to staff who manage students", async () => {
    const { post } = testSchool();

    const byTeacher = await post("/commands/enlist-student/version/2", bruce, asTeacher);
    const byRegistrar = await post("/commands/enlist-student/version/2", bruce);

    expect([byTeacher.status, byRegistrar.status]).toEqual([403, 200]);
  });

  it("turns anonymous callers away", async () => {
    const { post } = testSchool();

    const anonymous = await post("/queries/student-profile/version/1", { studentId: "s-1" }, {});

    expect(anonymous.status).toBe(401);
  });
});

describe("retried enlistments", () => {
  it("enlist one student, however often the request is retried", async () => {
    const { post, stateStore } = testSchool();
    const retry = { authorization: "Bearer registrar-token", "idempotency-key": "enlist-bruce" };
    const bruce = { firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" };

    const first = await post("/commands/enlist-student/version/1", bruce, retry);
    const second = await post("/commands/enlist-student/version/1", bruce, retry);

    expect(second.body).toEqual(first.body);
    expect(stateStore.all).toHaveLength(1);
  });
});
