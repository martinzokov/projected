import { Result, type Authenticator, type Principal } from "@projected/application";

/** A principal for tests. */
export function principal(id: string, permissions: readonly string[] = [], kind: Principal["kind"] = "user"): Principal {
  return { id, kind, permissions, claims: {} };
}

/**
 * An {@link Authenticator} for tests: `Authorization: Bearer <token>` maps to the principal
 * registered for that token; anything else is anonymous.
 */
export function tokenAuthenticator(principals: Readonly<Record<string, Principal>>): Authenticator {
  return {
    authenticate: async ({ headers }) => {
      const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
      return Result.ok(token === undefined ? undefined : principals[token]);
    },
  };
}
