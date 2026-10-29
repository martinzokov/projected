import { describe, expect, it } from "vitest";
import { caller } from "../src/application/usecase/access.js";

describe("the caller", () => {
  it("must be there: every ledger operation is for signed-in callers, so its absence is a defect", () => {
    const anonymous = { metadata: { messageId: "m-1", correlationId: "m-1", causationId: undefined, idempotencyKey: undefined, principal: undefined } };

    expect(() => caller(anonymous)).toThrow(/for signed-in callers only/);
  });
});
