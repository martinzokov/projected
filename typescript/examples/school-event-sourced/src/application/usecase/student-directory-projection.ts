import { defineEventHandler } from "@projected/application/event-sourced";
import { StudentEnlisted, StudentLastnameChanged, StudentWithdrawn } from "../../domain/student/events.js";
import type { StudentDirectory } from "../port/driven/student-directory.js";

/** Keeps the student directory read model in step with student events. Idempotent: safe to replay. */
export const studentDirectoryProjection = (deps: { directory: StudentDirectory }) =>
  defineEventHandler({
    name: "student-directory",
    events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],
    handle: {
      StudentEnlisted: ({ data }) => deps.directory.put(data),
      StudentLastnameChanged: ({ data }) => deps.directory.rename(data.studentId, data.newLastname),
      StudentWithdrawn: ({ data }) => deps.directory.remove(data.studentId),
    },
  });
