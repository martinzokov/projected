import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DependencyUnavailable, Result, type SchemaMigrator } from "@projected/application";
import { loadMigrations, loadProject, migrate, run } from "@projected/cli";

/** A migrator over an in-memory list of changes. */
function migrator(name: string, pending: string[]): SchemaMigrator {
  return { name, pending: async () => Result.ok([...pending]), apply: async () => Result.ok(pending.splice(0)) };
}

const unreachable: SchemaMigrator = {
  name: "projected",
  pending: async () => Result.err(new DependencyUnavailable({ dependency: "postgres", message: "postgres: connection refused" })),
  apply: async () => Result.err(new DependencyUnavailable({ dependency: "postgres", message: "postgres: connection refused" })),
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A project whose migrations module is `source(root)`. */
function projectWithMigrations(source?: (root: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), "projected-migrate-"));
  roots.push(root);
  writeFileSync(join(root, "projected.json"), JSON.stringify({ flavour: "state-based" }));
  if (source !== undefined) {
    mkdirSync(join(root, "src/infrastructure/config"), { recursive: true });
    writeFileSync(join(root, "src/infrastructure/config/migrations.ts"), source(root));
  }
  return root;
}

describe("projected migrate", () => {
  it("applies each migrator in order and says what changed", async () => {
    const result = await migrate({ migrators: [migrator("projected", ["core@1", "state-based@1"]), migrator("better-auth", [])] });

    expect(result).toEqual({ ok: true, lines: ["projected: applied core@1, state-based@1", "better-auth: up to date"] });
  });

  it("with --check changes nothing, and fails while changes are pending", async () => {
    const projected = migrator("projected", ["core@2"]);

    const result = await migrate({ migrators: [projected, migrator("better-auth", ["add user.role"])] }, { check: true });

    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([
      "projected: pending core@2",
      "better-auth: pending add user.role",
      "migrate: 2 change(s) pending — run `projected migrate` before starting this version",
    ]);
    expect((await projected.pending()).unwrap()).toEqual(["core@2"]);
  });

  it("with --check passes when every table is current", async () => {
    const result = await migrate({ migrators: [migrator("projected", [])] }, { check: true });

    expect(result).toEqual({ ok: true, lines: ["projected: up to date"] });
  });

  it("stops at the first migrator that fails, leaving the rest alone", async () => {
    const auth = migrator("better-auth", ["create user"]);

    const result = await migrate({ migrators: [unreachable, auth] });

    expect(result).toEqual({ ok: false, lines: ["projected: postgres: connection refused"] });
    expect((await auth.pending()).unwrap()).toEqual(["create user"]);
  });

  it("says where the migrations module belongs when the service has none", async () => {
    const root = projectWithMigrations();
    const lines: string[] = [];

    const code = await run(["migrate", "--root", root], (line) => lines.push(line));

    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^error: Migrations module not found: .*src\/infrastructure\/config\/migrations\.ts\. Export `migrations\(env\)`/);
  });

  it("fails when the module finds no database, and lets go of what it opened", async () => {
    const root = projectWithMigrations(
      (dir) => `import { writeFileSync } from "node:fs";
export function migrations() {
  return { migrators: [], close: async () => writeFileSync(${JSON.stringify(join(dir, "closed"))}, "") };
}
`,
    );
    const lines: string[] = [];

    const code = await run(["migrate", "--root", root], (line) => lines.push(line));

    expect(code).toBe(1);
    expect(lines).toEqual([
      "error: src/infrastructure/config/migrations.ts found nothing to migrate. Point it at the database: a generated service reads DATABASE_URL.",
    ]);
    expect(existsSync(join(root, "closed"))).toBe(true);
  });
});

const url = process.env.PROJECTED_TEST_DATABASE_URL;
const school = fileURLToPath(new URL("../../../examples/school-state-based", import.meta.url));
const database = `projected_migrate_${process.pid}`;

/** Runs the school's own migrations module against a database of its own. Set PROJECTED_TEST_DATABASE_URL to enable. */
describe.skipIf(url === undefined)("projected migrate against PostgreSQL", () => {
  const admin = async <T>(work: (client: import("pg").Client) => Promise<T>) => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return work(client).finally(() => client.end());
  };
  afterAll(() => admin((client) => client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)));

  it("brings a new database up to date for the service, then finds nothing left to do", async () => {
    await admin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${database}`);
    });
    const target = new URL(url!);
    target.pathname = `/${database}`;
    const env = { DATABASE_URL: target.toString() };
    const project = loadProject(school);
    const once = async (check: boolean) => {
      const migrations = await loadMigrations(project, env);
      return migrate(migrations, { check }).finally(() => migrations.close?.());
    };

    const before = await once(true);
    const applied = await once(false);
    const after = await once(true);

    expect(before.ok).toBe(false);
    expect(before.lines[0]).toBe("projected: pending core@1, state-based@1");
    expect(before.lines[1]).toMatch(/^better-auth: pending create user, create session/);
    expect(applied.ok).toBe(true);
    expect(applied.lines[0]).toBe("projected: applied core@1, state-based@1");
    expect(after).toEqual({ ok: true, lines: ["projected: up to date", "better-auth: up to date"] });
  }, 60_000);
});
