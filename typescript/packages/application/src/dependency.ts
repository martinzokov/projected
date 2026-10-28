import { Result } from "@projected/domain";
import { DependencyFailure, DependencyUnavailable } from "./errors.js";

/** What a thrown failure of a dependency means: worth retrying (`unavailable`), or not without a fix (`failure`). */
export type FailureKind = "unavailable" | "failure";

export interface FromDependencyOptions {
  /** Decide what a thrown value means. Defaults to {@link classifyFailure}. */
  readonly classify?: (cause: unknown) => FailureKind;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * The default reading of a thrown value: network errors, timeouts, aborts and 408/425/429/5xx
 * statuses (as SDKs expose them in `status` or `statusCode`) mean the dependency is unavailable
 * and a retry may succeed; anything else is a failure that needs a fix.
 */
export function classifyFailure(cause: unknown): FailureKind {
  return classify(cause, 0);
}

function classify(cause: unknown, depth: number): FailureKind {
  if (typeof cause !== "object" || cause === null) return "failure";
  const { name, code, status, statusCode } = cause as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  if (name === "AbortError" || name === "TimeoutError") return "unavailable";
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return "unavailable";
  const httpStatus = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
  if (httpStatus !== undefined) return TRANSIENT_STATUSES.has(httpStatus) ? "unavailable" : "failure";
  // `fetch` and many clients wrap the network error: look one level down.
  const inner = (cause as { cause?: unknown }).cause;
  return depth === 0 && inner !== undefined ? classify(inner, 1) : "failure";
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Call an SDK or client that throws or rejects, and get a Result instead — the boundary every
 * driven adapter keeps: nothing an outside system does may escape as an exception.
 *
 * ```ts
 * export const sesMailer = (ses: SESClient): Mailer => ({
 *   send: async (message) =>
 *     (await fromDependency("email", () => ses.send(new SendEmailCommand(toSes(message))))).map(() => undefined),
 * });
 * ```
 *
 * Failures become {@link DependencyUnavailable} (retryable: the caller gets a 503, a queued
 * command is redelivered) or {@link DependencyFailure} (a 502), decided by `classify`.
 */
export function fromDependency<T>(
  dependency: string,
  work: () => Promise<T>,
  options: FromDependencyOptions = {},
): Promise<Result<T, DependencyUnavailable | DependencyFailure>> {
  const kindOf = options.classify ?? classifyFailure;
  return Result.tryPromise({
    try: work,
    catch: (cause): DependencyUnavailable | DependencyFailure => {
      const message = `${dependency}: ${describe(cause)}`;
      return kindOf(cause) === "unavailable"
        ? new DependencyUnavailable({ dependency, message, cause })
        : new DependencyFailure({ dependency, message, cause });
    },
  });
}
