import type { DependencyUnavailable, Result } from "@projected/application";

export interface DirectoryEntry {
  readonly studentId: string;
  readonly firstname: string;
  readonly lastname: string;
  readonly joiningDate: string;
}

/**
 * Read model of enlisted students, kept up to date by the student-directory projection.
 * Named for what the application needs, not for what stores it.
 */
export interface StudentDirectory {
  put(entry: DirectoryEntry): Promise<Result<void, DependencyUnavailable>>;
  rename(studentId: string, lastname: string): Promise<Result<void, DependencyUnavailable>>;
  remove(studentId: string): Promise<Result<void, DependencyUnavailable>>;
  joinedOn(date: string): Promise<Result<readonly DirectoryEntry[], DependencyUnavailable>>;
}
