import type { Access } from "./contract.js";
import { Forbidden, Unauthenticated } from "./errors.js";
import type { Principal } from "./ports.js";

/** Why a principal may not run an operation under `access`, or `undefined` when it may. */
export function checkAccess(
  operation: string,
  access: Access,
  principal: Principal | undefined,
): Unauthenticated | Forbidden | undefined {
  if (access === "public") return undefined;
  if (principal === undefined) {
    return new Unauthenticated({ operation, message: `${operation} requires an authenticated caller` });
  }
  if (access === "authenticated") return undefined;
  const missing = access.permissions.filter((permission) => !principal.permissions.includes(permission));
  if (missing.length === 0) return undefined;
  return new Forbidden({ operation, missing, message: `${operation} requires ${missing.join(", ")}` });
}
