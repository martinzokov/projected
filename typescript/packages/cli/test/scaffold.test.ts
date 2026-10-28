import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEPENDENCY_VERSIONS,
  loadProject,
  newAggregate,
  newCommand,
  newEventHandler,
  newPort,
  newQuery,
  newService,
} from "@projected/cli";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..", "..", "..");
const scratch = join(here, "..", ".tsbuild", "scaffold");
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const projected = join(here, "..", "bin", "projected.js");
const exec = promisify(execFile);
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Flavour = "event-sourced" | "state-based";

/** A new service in the workspace, with the framework and its other dependencies linked as `pnpm install` would. */
function service(flavour: Flavour, aggregate = "invoice"): string {
  const parent = join(scratch, `${process.pid}-${++counter}`);
  const root = join(parent, "billing");
  mkdirSync(parent, { recursive: true });
  const created = newService(parent, "billing", { flavour, aggregate });
  if (!created.ok) throw new Error(created.lines.join("\n"));
  mkdirSync(join(root, "node_modules", "@projected"), { recursive: true });
  for (const name of readdirSync(join(workspace, "packages"))) {
    symlinkSync(join(workspace, "packages", name), join(root, "node_modules", "@projected", name), "dir");
  }
  const installed = join(workspace, "examples", "school-event-sourced", "node_modules");
  for (const name of ["better-auth", "pg", "@types/pg", "@opentelemetry/api"]) {
    mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
    symlinkSync(realpathSync(join(installed, name)), join(root, "node_modules", name), "dir");
  }
  return root;
}

/** Every file of the service but its dependencies, with its content. */
function files(root: string, dir = root): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") Object.assign(found, files(root, path));
    else if (entry.isFile()) found[relative(root, path)] = readFileSync(path, "utf8");
  }
  return found;
}

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

/** Run a tool in the generated service as its developer would, outside this test runner. */
async function inService(root: string, script: string, ...args: string[]): Promise<{ code: number; output: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("a new service", () => {
  it.each<Flavour>(["event-sourced", "state-based"])(
    "compiles, passes projected check and its own tests as every generator adds to it (%s)",
    async (flavour) => {
      const root = service(flavour);
      const project = () => loadProject(root);

      const results = [
        newCommand(project(), "issue-invoice", { aggregate: "invoice", event: "InvoiceIssued" }),
        newCommand(project(), "void-invoice", { aggregate: "invoice", event: "InvoiceVoided" }),
        newQuery(project(), "invoice-summary", { aggregate: "invoice" }),
        newPort(project(), "InvoiceArchive", { operations: "archive,findByCustomer" }),
        newQuery(project(), "archived-invoices", { port: "InvoiceArchive" }),
        newEventHandler(project(), "invoice-archiving", { on: "InvoiceIssued,InvoiceVoided", port: "InvoiceArchive" }),
        newAggregate(project(), "lineItem"),
        newCommand(project(), "add-line-item", { aggregate: "lineItem", event: "LineItemAdded" }),
        newEventHandler(project(), "invoice-reminders", { on: "InvoiceIssued" }),
      ];
      expect(results.filter((result) => !result.ok)).toEqual([]);

      const compiled = await inService(root, tsc, "-b");
      for (const step of [["openapi"], ["contracts", "--update"], ["docs"]]) await inService(root, projected, ...step);
      const check = await inService(root, projected, "check", "--strict");
      const tests = await inService(root, vitest, "run", "--config", "vitest.config.ts");

      expect(compiled).toEqual({ code: 0, output: "" });
      expect(check).toMatchObject({ code: 0 });
      expect(check.output).toContain("contracts.lock.json matches all 5 operations");
      expect(tests).toMatchObject({ code: 0 });
      expect(tests.output).toMatch(/Tests\s+12 passed/);
    },
    240_000,
  );

  it("depends on the workspace's framework packages inside the framework's workspace, and on releases outside it", () => {
    const outside = mkdtempSync(join(tmpdir(), "projected-new-"));
    try {
      newService(outside, "billing", { flavour: "state-based", aggregate: "invoice" });
      const inside = service("state-based");

      const range = (root: string) => (JSON.parse(read(root, "package.json")) as { dependencies: Record<string, string> }).dependencies["@projected/application"];

      expect(range(inside)).toBe("workspace:*");
      expect(range(join(outside, "billing"))).toMatch(/^\^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("pins its other dependencies to the versions the framework is tested with", () => {
    const manifest = (path: string) => JSON.parse(readFileSync(join(workspace, path), "utf8")) as Record<string, Record<string, string>>;
    const root = manifest("package.json");
    const example = manifest("examples/school-event-sourced/package.json");
    const tested = { ...root["devDependencies"], ...example["dependencies"], ...example["devDependencies"] };

    for (const [name, version] of Object.entries(DEPENDENCY_VERSIONS)) expect([name, version]).toEqual([name, tested[name]]);
  });

  it("will not be created without a flavour, which is fixed from then on", () => {
    const parent = mkdtempSync(join(tmpdir(), "projected-new-"));
    try {
      const result = newService(parent, "billing", { aggregate: "invoice" });

      expect(result.ok).toBe(false);
      expect(result.lines.join("\n")).toMatch(/--flavour event-sourced \| state-based.*fixed once the service exists/);
      expect(existsSync(join(parent, "billing"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("the generators", () => {
  it("name a command's decision for its words without the aggregate's, and never for a keyword", () => {
    const root = service("event-sourced");

    newCommand(loadProject(root), "report-invoice-payment", { aggregate: "invoice", event: "InvoicePaymentReported" });
    newCommand(loadProject(root), "void-invoice", { aggregate: "invoice", event: "InvoiceVoided" });

    expect(read(root, "src/domain/invoice/invoice.ts")).toContain("export function reportPayment(");
    expect(read(root, "src/domain/invoice/invoice.ts")).toContain("export function decideVoidInvoice(");
  });

  it("grow each list and import in the layout it already has", () => {
    const root = service("event-sourced");

    newCommand(loadProject(root), "issue-invoice", { aggregate: "invoice", event: "InvoiceIssued" });
    newCommand(loadProject(root), "void-invoice", { aggregate: "invoice", event: "InvoiceVoided" });

    expect(read(root, "src/application/port/driving/index.ts")).toContain("commands: [IssueInvoice, VoidInvoice],");
    expect(read(root, "src/infrastructure/config/billing.ts")).toContain(
      ['    commands: {', '      "issue-invoice@1": issueInvoice({ invoices }),', '      "void-invoice@1": voidInvoice({ invoices }),', "    },"].join("\n"),
    );
    expect(read(root, "src/domain/invoice/invoice.ts")).toContain('import { Result, defineAggregate, type Decision } from "@projected/domain/event-sourced";');
    expect(read(root, "src/infrastructure/config/billing.ts")).toMatch(/^  aggregateRepository,\n  createApplication,\n  type CheckpointStore,$/m);
  });

  it("wire a port's adapter into the composition root once, passing it the store it takes", () => {
    const root = service("state-based");
    newCommand(loadProject(root), "issue-invoice", { aggregate: "invoice", event: "InvoiceIssued" });
    newPort(loadProject(root), "InvoiceArchive", { operations: "archive" });

    newQuery(loadProject(root), "archived-invoices", { port: "InvoiceArchive" });
    newEventHandler(loadProject(root), "invoice-archiving", { on: "InvoiceIssued", port: "InvoiceArchive" });

    const composition = read(root, "src/infrastructure/config/billing.ts");
    expect(composition.match(/const invoiceArchive = documentInvoiceArchive\(documents\);/g)).toHaveLength(1);
    expect(composition).toContain("const { stateStore, checkpoints, idempotency, ids, telemetry, documents } = infrastructure;");
  });

  it.each([
    ["a command named for a data change", (root: string) => newCommand(loadProject(root), "update-invoice", { aggregate: "invoice", event: "InvoiceUpdated" }), /names a data change \(update\)/],
    ["a command for an aggregate that does not exist", (root: string) => newCommand(loadProject(root), "issue-receipt", { aggregate: "receipt", event: "ReceiptIssued" }), /no aggregate receipt.*projected new aggregate receipt/],
    ["a query that names neither an aggregate nor a port", (root: string) => newQuery(loadProject(root), "invoice-summary", {}), /reads one aggregate \(--aggregate <name>\) or a read model behind a port/],
    ["an event handler for an event that does not exist", (root: string) => newEventHandler(loadProject(root), "reminders", { on: "InvoiceSent" }), /no event InvoiceSent/],
    ["a query on a port that does not exist", (root: string) => newQuery(loadProject(root), "archived-invoices", { port: "InvoiceArchive" }), /no port InvoiceArchive/],
  ])("refuse %s, and write nothing", (_case, generate, reason) => {
    const root = service("event-sourced");
    const before = files(root);

    const result = generate(root);

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(reason);
    expect(files(root)).toEqual(before);
  });

  it("refuse an event that already exists, and write nothing", () => {
    const root = service("event-sourced");
    newCommand(loadProject(root), "issue-invoice", { aggregate: "invoice", event: "InvoiceIssued" });
    const before = files(root);

    const result = newCommand(loadProject(root), "reissue-invoice", { aggregate: "invoice", event: "InvoiceIssued" });

    expect(result.lines.join("\n")).toMatch(/event InvoiceIssued already exists/);
    expect(files(root)).toEqual(before);
  });
});
