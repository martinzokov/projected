import type { DependencyFailure, DependencyUnavailable, Result } from "@projected/application/state-based";

export interface DirectoryEntry {
  readonly studentId: string;
  readonly firstname: string;
  readonly lastname: string;
  readonly joiningDate: string;
}

type StorageError = DependencyUnavailable | DependencyFailure;

/**
 * Read model of enlisted students, kept up to date by the student-directory projection.
 * Named for what the application needs, not for what stores it.
 */
export interface StudentDirectory {
  put(entry: DirectoryEntry): Promise<Result<void, StorageError>>;
  rename(studentId: string, lastname: string): Promise<Result<void, StorageError>>;
  remove(studentId: string): Promise<Result<void, StorageError>>;
  joinedOn(date: string): Promise<Result<readonly DirectoryEntry[], StorageError>>;
}
