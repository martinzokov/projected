import { describe, expect, it } from "vitest";
import { DependencyFailure, DependencyUnavailable, classifyFailure, fromDependency } from "@projected/application";

const rejectWith = (cause: unknown) => () => Promise.reject(cause);
const errorWith = (fields: Record<string, unknown>) => Object.assign(new Error("boom"), fields);

describe("fromDependency", () => {
  it("passes a successful value through as Ok", async () => {
    const outcome = await fromDependency("email", async () => 42);

    expect(outcome.unwrap()).toBe(42);
  });

  it("turns a network error into DependencyUnavailable, naming the dependency", async () => {
    const outcome = await fromDependency("email", rejectWith(errorWith({ code: "ECONNREFUSED" })));

    expect(outcome.isErr() && DependencyUnavailable.is(outcome.error)).toBe(true);
    expect(outcome.isErr() && outcome.error.message).toBe("email: boom");
  });

  it("turns anything it cannot recognise as transient into DependencyFailure", async () => {
    const outcome = await fromDependency("email", rejectWith(new Error("invalid recipient")));

    expect(outcome.isErr() && DependencyFailure.is(outcome.error)).toBe(true);
  });

  it("keeps the original error as the cause", async () => {
    const cause = errorWith({ status: 503 });

    const outcome = await fromDependency("email", rejectWith(cause));

    expect(outcome.isErr() && outcome.error.cause).toBe(cause);
  });

  it("lets the adapter decide what a failure means", async () => {
    const outcome = await fromDependency("email", rejectWith(new Error("throttled")), { classify: () => "unavailable" });

    expect(outcome.isErr() && DependencyUnavailable.is(outcome.error)).toBe(true);
  });
});

describe("classifyFailure", () => {
  it.each([
    ["a refused connection", errorWith({ code: "ECONNREFUSED" }), "unavailable"],
    ["a timeout", Object.assign(new Error("slow"), { name: "TimeoutError" }), "unavailable"],
    ["an abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "unavailable"],
    ["fetch wrapping a socket error", Object.assign(new TypeError("fetch failed"), { cause: errorWith({ code: "UND_ERR_SOCKET" }) }), "unavailable"],
    ["a 429 from an SDK", errorWith({ status: 429 }), "unavailable"],
    ["a 503 as statusCode", errorWith({ statusCode: 503 }), "unavailable"],
    ["a 400 from an SDK", errorWith({ status: 400 }), "failure"],
    ["a plain error", new Error("nope"), "failure"],
    ["a thrown string", "nope", "failure"],
  ])("reads %s as %s", (_name, cause, expected) => {
    expect(classifyFailure(cause)).toBe(expected);
  });
});
