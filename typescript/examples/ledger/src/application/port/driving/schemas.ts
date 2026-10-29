import { z } from "@projected/application/event-sourced";

/** Ids clients choose for accounts and transfers: short, and safe in a stream name. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "1 to 64 letters, digits, dashes or underscores");

/** Bank staff: open and close accounts, read any of them. */
export const MANAGE_ACCOUNTS = "accounts:manage";
/** Tellers and cash machines: pay money in and out. */
export const HANDLE_CASH = "cash:handle";
