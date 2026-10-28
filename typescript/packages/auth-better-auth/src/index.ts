/**
 * @projected/auth-better-auth — authenticate projected requests with better-auth.
 *
 * ```ts
 * const auth = betterAuth({ database, emailAndPassword: { enabled: true }, plugins: [bearer(), admin()] });
 * const handler = httpHandler(app, {
 *   authenticator: betterAuthAuthenticator(auth, { roles: { admin: ["students:manage"] } }),
 *   routes: betterAuthRoutes(auth),
 *   openApi: { securitySchemes: betterAuthSecuritySchemes() },
 * });
 * ```
 *
 * Infrastructure-only: wire it in `src/infrastructure/config`. Use cases see only the resulting
 * `Principal`, so swapping better-auth for another provider never touches them.
 */
import { DependencyUnavailable, Result, fromDependency, type Authenticator, type Principal, type SchemaMigrator } from "@projected/application";

/** The parts of a better-auth session the adapter reads. */
export interface BetterAuthSession {
  readonly user: {
    readonly id: string;
    readonly email?: string | null | undefined;
    readonly name?: string | null | undefined;
    readonly emailVerified?: boolean | null | undefined;
    /** Set by better-auth's admin plugin; several roles are comma-separated. */
    readonly role?: string | null | undefined;
    readonly [field: string]: unknown;
  };
  readonly session: { readonly id: string; readonly [field: string]: unknown };
}

/**
 * The parts of a better-auth instance the adapter uses. Typed structurally so that any
 * better-auth configuration (plugins change its exact type) is accepted.
 */
export interface BetterAuthInstance {
  readonly api: { getSession(context: { headers: Headers }): Promise<BetterAuthSession | null> };
  handler(request: Request): Promise<Response>;
}

export interface BetterAuthAuthenticatorOptions {
  /**
   * Permissions granted per role. Roles come from the user's `role` field (better-auth's admin
   * plugin). A user without a role, or with an unlisted one, gets no permissions.
   */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
  /** Derive permissions yourself — e.g. from an organization membership — instead of `roles`. */
  readonly permissions?: (session: BetterAuthSession) => readonly string[] | Promise<readonly string[]>;
}

/** Roles of a user, as better-auth's admin plugin stores them. */
export const rolesOf = (session: BetterAuthSession): string[] =>
  (session.user.role ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "");

/**
 * An {@link Authenticator} that resolves the request's better-auth session — from the session
 * cookie, or `Authorization: Bearer` with the bearer plugin — into a principal.
 */
export function betterAuthAuthenticator(auth: BetterAuthInstance, options: BetterAuthAuthenticatorOptions = {}): Authenticator {
  const permissionsOf = async (session: BetterAuthSession): Promise<readonly string[]> => {
    if (options.permissions !== undefined) return options.permissions(session);
    const granted = rolesOf(session).flatMap((role) => options.roles?.[role] ?? []);
    return [...new Set(granted)];
  };

  return {
    authenticate: async ({ headers }) => {
      let session: BetterAuthSession | null;
      try {
        session = await auth.api.getSession({ headers: new Headers(headers) });
      } catch (cause) {
        return Result.err(new DependencyUnavailable({ dependency: "better-auth", message: "better-auth: cannot read the session", cause }));
      }
      if (session === null) return Result.ok(undefined);
      const principal: Principal = {
        id: session.user.id,
        kind: "user",
        permissions: await permissionsOf(session),
        claims: {
          sessionId: session.session.id,
          email: session.user.email ?? undefined,
          name: session.user.name ?? undefined,
          emailVerified: session.user.emailVerified ?? undefined,
          roles: rolesOf(session),
        },
      };
      return Result.ok(principal);
    },
  };
}

/** better-auth's own endpoints (sign-up, sign-in, sessions, ...), to mount next to the operations. */
export function betterAuthRoutes(
  auth: BetterAuthInstance,
  basePath = "/api/auth",
): Record<string, (request: Request) => Promise<Response>> {
  return { [basePath]: (request) => auth.handler(request) };
}

/**
 * OpenAPI security schemes for better-auth: the session cookie, and bearer tokens (bearer
 * plugin). Pass `cookieName` if you changed better-auth's cookie prefix.
 */
export function betterAuthSecuritySchemes(options: { readonly cookieName?: string } = {}): Record<string, unknown> {
  return {
    betterAuthSession: {
      type: "apiKey",
      in: "cookie",
      name: options.cookieName ?? "better-auth.session_token",
      description: "Session cookie set by better-auth's sign-in endpoints.",
    },
    bearer: { type: "http", scheme: "bearer", description: "Session token from better-auth's bearer plugin." },
  };
}

/** What better-auth's `getMigrations(options)` plans, as far as the migrator reads it. */
export interface BetterAuthMigrationPlan {
  readonly toBeCreated: ReadonlyArray<{ readonly table: string }>;
  readonly toBeAdded: ReadonlyArray<{ readonly table: string; readonly fields: Readonly<Record<string, unknown>> }>;
  readonly toBeAddedIndexes?: ReadonlyArray<{ readonly name: string }>;
  runMigrations(): Promise<void>;
}

const changesIn = (plan: BetterAuthMigrationPlan): string[] => [
  ...plan.toBeCreated.map(({ table }) => `create ${table}`),
  ...plan.toBeAdded.flatMap(({ table, fields }) => Object.keys(fields).map((field) => `add ${table}.${field}`)),
  ...(plan.toBeAddedIndexes ?? []).map(({ name }) => `index ${name}`),
];

/**
 * better-auth's tables as a {@link SchemaMigrator}, so `projected migrate` creates them with
 * projected's, before a rollout. Plan with the options the service creates better-auth with:
 * its plugins decide the columns.
 *
 * ```ts
 * betterAuthMigrator(() => getMigrations(authOptions)) // getMigrations from "better-auth/db/migration"
 * ```
 *
 * better-auth takes no lock while it migrates, so apply it from one process: the deploy step,
 * or a single instance.
 */
export function betterAuthMigrator(plan: () => Promise<BetterAuthMigrationPlan>): SchemaMigrator {
  const dependency = "better-auth tables";
  return {
    name: "better-auth",
    pending: () => fromDependency(dependency, async () => changesIn(await plan())),
    apply: () =>
      fromDependency(dependency, async () => {
        const planned = await plan();
        const changes = changesIn(planned);
        if (changes.length > 0) await planned.runMigrations();
        return changes;
      }),
  };
}
