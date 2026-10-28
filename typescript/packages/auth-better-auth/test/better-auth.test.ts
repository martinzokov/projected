import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, defineQuery, z } from "@projected/application";
import {
  betterAuthAuthenticator,
  betterAuthMigrator,
  betterAuthRoutes,
  betterAuthSecuritySchemes,
  type BetterAuthInstance,
  type BetterAuthMigrationPlan,
} from "@projected/auth-better-auth";
import { httpHandler, openApiDocument } from "@projected/http";
import { sequentialIds } from "@projected/testing";

const Whoami = defineQuery({ type: "whoami", input: z.object({}), output: z.object({ id: z.string(), roles: z.array(z.string()) }) });
const PublishGrades = defineCommand({
  type: "publish-grades",
  input: z.object({}),
  output: z.object({}),
  access: { permissions: ["grades:publish"] },
});
const school = defineContracts({ name: "school", access: "authenticated", commands: [PublishGrades], queries: [Whoami] });

function setup() {
  const db: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: "http://school.test",
    secret: "test-secret-test-secret-test-secret-1234",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [bearer(), admin()],
  });
  const instance: BetterAuthInstance = auth;
  const app = createApplication(school, {
    ids: sequentialIds(),
    commands: { "publish-grades@1": () => Result.ok({}) },
    queries: {
      "whoami@1": (_input, context) =>
        Result.ok({ id: context.metadata.principal?.id ?? "", roles: (context.metadata.principal?.claims.roles as string[]) ?? [] }),
    },
  });
  const handler = httpHandler(app, {
    authenticator: betterAuthAuthenticator(instance, { roles: { teacher: ["grades:publish"] } }),
    routes: betterAuthRoutes(instance),
  });
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`http://school.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://school.test", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const signUp = async (email: string) => {
    const response = await call("/api/auth/sign-up/email", { email, password: "correct-horse-battery", name: email });
    return {
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
      token: response.headers.get("set-auth-token") ?? "",
      userId: ((await response.json()) as { user: { id: string } }).user.id,
    };
  };
  return { db, call, signUp };
}

describe("better-auth", () => {
  it("serves better-auth's routes and authenticates with its session cookie", async () => {
    const { call, signUp } = setup();
    const { cookie, userId } = await signUp("ada@example.com");

    const response = await call("/queries/whoami/version/1", {}, { cookie });

    expect(await response.json()).toEqual({ status: "ok", value: { id: userId, roles: ["user"] } });
  });

  it("authenticates with a bearer token", async () => {
    const { call, signUp } = setup();
    const { token, userId } = await signUp("ada@example.com");

    const response = await call("/queries/whoami/version/1", {}, { authorization: `Bearer ${token}` });

    expect(((await response.json()) as { value: { id: string } }).value.id).toBe(userId);
  });

  it("treats a missing or invalid session as anonymous", async () => {
    const { call } = setup();

    expect((await call("/queries/whoami/version/1", {})).status).toBe(401);
    expect((await call("/queries/whoami/version/1", {}, { authorization: "Bearer forged" })).status).toBe(401);
  });

  it("grants permissions from the user's roles", async () => {
    const { db, call, signUp } = setup();
    const { cookie, userId } = await signUp("ada@example.com");

    const asUser = await call("/commands/publish-grades/version/1", {}, { cookie });
    const user = db.user?.find((candidate) => candidate.id === userId);
    if (user !== undefined) user.role = "user,teacher";
    const asTeacher = await call("/commands/publish-grades/version/1", {}, { cookie });

    expect([asUser.status, asTeacher.status]).toEqual([403, 200]);
  });

  it("reports an unreachable session store as 503", async () => {
    const broken: BetterAuthInstance = {
      api: { getSession: () => Promise.reject(new Error("database down")) },
      handler: async () => new Response(null, { status: 500 }),
    };
    const app = createApplication(school, {
      ids: sequentialIds(),
      commands: { "publish-grades@1": () => Result.ok({}) },
      queries: { "whoami@1": () => Result.ok({ id: "", roles: [] }) },
    });

    const response = await httpHandler(app, { authenticator: betterAuthAuthenticator(broken) })(
      new Request("http://school.test/queries/whoami/version/1", { method: "POST" }),
    );

    expect(response.status).toBe(503);
  });

  it("documents its security schemes", () => {
    const document = openApiDocument(school, { securitySchemes: betterAuthSecuritySchemes() });
    const whoami = (document.paths["/queries/whoami/version/1"] as { post: { security: unknown } }).post;

    expect(whoami.security).toEqual([{ betterAuthSession: [] }, { bearer: [] }]);
  });
});

/** A plan like getMigrations' for a database with a user table that lacks the admin plugin's columns. */
function plan(ran: string[]): BetterAuthMigrationPlan {
  return {
    toBeCreated: [{ table: "session" }],
    toBeAdded: [{ table: "user", fields: { role: {}, banned: {} } }],
    toBeAddedIndexes: [{ name: "session_userId_idx" }],
    runMigrations: async () => {
      ran.push("migrated");
    },
  };
}

describe("the better-auth migrator", () => {
  it("lists the tables, columns and indexes better-auth would create, running nothing", async () => {
    const ran: string[] = [];

    const pending = await betterAuthMigrator(async () => plan(ran)).pending();

    expect(pending.unwrap()).toEqual(["create session", "add user.role", "add user.banned", "index session_userId_idx"]);
    expect(ran).toEqual([]);
  });

  it("runs better-auth's migrations when something is pending, and reports what they changed", async () => {
    const ran: string[] = [];

    const applied = await betterAuthMigrator(async () => plan(ran)).apply();

    expect(applied.unwrap()).toHaveLength(4);
    expect(ran).toEqual(["migrated"]);
  });

  it("leaves current tables alone", async () => {
    const ran: string[] = [];
    const current = { ...plan(ran), toBeCreated: [], toBeAdded: [], toBeAddedIndexes: [] };

    const applied = await betterAuthMigrator(async () => current).apply();

    expect(applied.unwrap()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("returns a failure to plan as a dependency error, never throwing", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

    const pending = await betterAuthMigrator(() => Promise.reject(refused)).pending();

    expect(pending.isErr() && pending.error).toMatchObject({ _tag: "DependencyUnavailable", dependency: "better-auth tables" });
  });
});
