import { describe, expect, it } from "vitest";
import { testSchool } from "./school.js";

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

  it("uses protocol status codes only for protocol problems", async () => {
    const { post } = testSchool();

    const invalid = await post("/commands/enlist-student/version/1", { firstname: "" });
    const unknown = await post("/commands/enrol-student/version/1", bruce);

    expect([invalid.status, unknown.status]).toEqual([400, 404]);
  });

  it("stamps events with the injected clock and the request's correlation", async () => {
    const { post, eventStore } = testSchool();
    await post("/commands/enlist-student/version/1", bruce);

    await post("/commands/report-student-lastname-change/version/1", { studentId: "student-1", newLastname: "Kent" });

    expect(eventStore.stream("student-student-1").map((event) => [event.type, event.data])).toEqual([
      ["StudentEnlisted", { studentId: "student-1", ...bruce }],
      [
        "StudentLastnameChanged",
        { studentId: "student-1", previousLastname: "Wayne", newLastname: "Kent", reportedAt: "2023-10-01T09:00:00.000Z" },
      ],
    ]);
    expect(eventStore.all[1]?.metadata).toEqual({ correlationId: "request-2", causationId: "request-2" });
  });
});
