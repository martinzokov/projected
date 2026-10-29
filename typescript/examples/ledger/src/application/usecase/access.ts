import { panic, type ExecutionContext, type Principal } from "@projected/application/event-sourced";
import { MANAGE_ACCOUNTS } from "../port/driving/schemas.js";

/** The caller. Every ledger operation requires one, so its absence is a broken invariant. */
export function caller(context: ExecutionContext): Principal {
  return context.metadata.principal ?? panic("ledger operations are for signed-in callers only, yet this one has no principal");
}

/** Staff see every account; a customer sees what is theirs. */
export const maySee = (principal: Principal, owner: string): boolean => principal.id === owner || principal.permissions.includes(MANAGE_ACCOUNTS);
