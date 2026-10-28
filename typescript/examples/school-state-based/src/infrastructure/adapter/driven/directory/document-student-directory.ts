import { Result, z, type DocumentStore } from "@projected/application/state-based";
import type { StudentDirectory } from "../../../../application/port/driven/student-directory.js";

const Entry = z.object({
  studentId: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  joiningDate: z.iso.date(),
});

/**
 * The {@link StudentDirectory} read model on any {@link DocumentStore} — in memory for tests,
 * PostgreSQL in production, and whatever store comes next, without changing this adapter.
 */
export function documentStudentDirectory(documents: DocumentStore): StudentDirectory {
  const entries = documents.collection("student-directory", Entry);
  return {
    put: (entry) => entries.put(entry.studentId, entry),
    rename: async (studentId, lastname) => {
      const current = await entries.get(studentId);
      if (current.isErr()) return Result.err(current.error);
      return current.value === undefined ? Result.ok(undefined) : entries.put(studentId, { ...current.value, lastname });
    },
    remove: (studentId) => entries.delete(studentId),
    joinedOn: (date) => entries.find({ joiningDate: date }, { orderBy: "lastname" }),
  };
}
