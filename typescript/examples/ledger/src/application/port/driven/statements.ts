import type { DependencyFailure, DependencyUnavailable, Result } from "@projected/application/event-sourced";

export interface BookedEntry {
  readonly accountId: string;
  /** The account's version that booked it: one entry per version, so recording it again changes nothing. */
  readonly entry: number;
  readonly kind: "deposit" | "withdrawal" | "transfer-sent" | "transfer-received";
  /** Signed, in minor units: money in is positive, money out negative. */
  readonly amount: number;
  readonly reference: string;
  readonly counterparty: string | null;
  readonly bookedAt: string;
}

type StorageError = DependencyUnavailable | DependencyFailure;

/** Read model of what was booked on each account, kept by the statement projection. */
export interface Statements {
  record(entry: BookedEntry): Promise<Result<void, StorageError>>;
  /** An account's entries booked in `month` (`2024-03`), in the order they were booked. */
  inMonth(accountId: string, month: string): Promise<Result<readonly BookedEntry[], StorageError>>;
}
