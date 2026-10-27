import type { QueryHandler } from "@projected/application";
import type { EnlistedStudentsOnJoiningDate } from "../port/driving/enlisted-students-on-joining-date.js";
import type { StudentDirectory } from "../port/driven/student-directory.js";

export const enlistedStudentsOnJoiningDate =
  (deps: { directory: StudentDirectory }): QueryHandler<typeof EnlistedStudentsOnJoiningDate> =>
  async ({ date }) =>
    (await deps.directory.joinedOn(date)).map((entries) => ({
      students: entries.map(({ studentId, firstname, lastname }) => ({ studentId, firstname, lastname })),
    }));
