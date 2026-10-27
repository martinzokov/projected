import { Result } from "@projected/application";
import type { Limits } from "../../../../application/port/driven/limits.js";

export const fixedLimits = (limit: number): Limits => ({
  limitFor: async () => Result.ok(limit),
});
