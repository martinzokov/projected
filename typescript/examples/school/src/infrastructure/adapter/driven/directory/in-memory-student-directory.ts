import { Result } from "@projected/application";
import type { DirectoryEntry, StudentDirectory } from "../../../../application/port/driven/student-directory.js";

/** A {@link StudentDirectory} in memory. A database-backed adapter would implement the same port. */
export function inMemoryStudentDirectory(): StudentDirectory {
  const entries = new Map<string, DirectoryEntry>();
  return {
    put: async (entry) => {
      entries.set(entry.studentId, entry);
      return Result.ok(undefined);
    },
    rename: async (studentId, lastname) => {
      const entry = entries.get(studentId);
      if (entry !== undefined) entries.set(studentId, { ...entry, lastname });
      return Result.ok(undefined);
    },
    remove: async (studentId) => {
      entries.delete(studentId);
      return Result.ok(undefined);
    },
    joinedOn: async (date) =>
      Result.ok([...entries.values()].filter((entry) => entry.joiningDate === date).sort((a, b) => a.lastname.localeCompare(b.lastname))),
  };
}
