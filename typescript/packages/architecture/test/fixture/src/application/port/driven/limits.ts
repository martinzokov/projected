import type { Result, DependencyUnavailable } from "@projected/application";

/** Where the application learns each counter's limit. */
export interface Limits {
  limitFor(counterId: string): Promise<Result<number, DependencyUnavailable>>;
}
