import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { files, inService, projected, read, removeScratch, service, tsc, vitest, type Flavour } from "./service.js";

const workspace = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

afterAll(removeScratch);

describe("the template and the school examples", () => {
  // The examples are the reference apps: what a new service shares with them must not drift apart.
  it.each<Flavour>(["event-sourced", "state-based"])("write the composition-root modules they share as the %s school has them", (flavour) => {
    const outside = mkdtempSync(join(tmpdir(), "projected-shared-"));
    try {
      newService(outside, "billing", { flavour, aggregate: "invoice" });
      const generated = join(outside, "billing", "src/infrastructure/config");
      const school = join(workspace, "examples", `school-${flavour}`, "src/infrastructure/config");

      for (const file of ["auth.ts", "migrations.ts", "migrate.ts", "web.ts"]) {
        expect(readFileSync(join(generated, file), "utf8"), file).toBe(readFileSync(join(school, file), "utf8"));
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

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
      expect(tests.output).toMatch(/Tests\s+16 passed/);
    },
    240_000,
  );

  it("is a pnpm workspace of its own, allowing esbuild's install script, unless it is inside one", () => {
    const outside = mkdtempSync(join(tmpdir(), "projected-new-"));
    try {
      newService(outside, "billing", { flavour: "state-based", aggregate: "invoice" });
      const inside = service("state-based");

      expect(read(join(outside, "billing"), "pnpm-workspace.yaml")).toMatch(/^allowBuilds:\n {2}esbuild: true$/m);
      expect(existsSync(join(inside, "pnpm-workspace.yaml"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

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

  // Outside the workspace a new service depends on every framework package at the CLI's own
  // version, so a release that leaves one package behind makes services that cannot install.
  it("depends on framework packages released in lockstep with the CLI", () => {
    const packages = join(workspace, "packages");
    const versions = Object.fromEntries(
      readdirSync(packages).map((name) => {
        const manifest = JSON.parse(readFileSync(join(packages, name, "package.json"), "utf8")) as { name: string; version: string };
        return [manifest.name, manifest.version];
      }),
    );
    const cli = versions["@projected/cli"];

    expect(Object.entries(versions).filter(([, version]) => version !== cli)).toEqual([]);
  });

  it("pins its other dependencies to the versions the framework is tested with", () => {
    const manifest = (path: string) => JSON.parse(readFileSync(join(workspace, path), "utf8")) as Record<string, Record<string, string>>;
    const root = manifest("package.json");
    const example = manifest("examples/school-event-sourced/package.json");
    const tested = { ...root["devDependencies"], ...example["dependencies"], ...example["devDependencies"] };

    for (const [name, version] of Object.entries(DEPENDENCY_VERSIONS)) expect([name, version]).toEqual([name, tested[name]]);
  });

  it("names no script after a command of pnpm's own, which would shadow it", () => {
    // `pnpm <name>` runs pnpm's command of that name, if it has one, before any script.
    const pnpmCommands = ["add", "audit", "bin", "config", "dedupe", "deploy", "docs", "dlx", "env", "exec", "fetch", "help", "import", "init", "install", "licenses", "link", "list", "ls", "outdated", "pack", "patch", "prune", "publish", "rebuild", "remove", "root", "server", "setup", "store", "unlink", "update", "why"];
    const root = service("state-based");

    const scripts = Object.keys((JSON.parse(read(root, "package.json")) as { scripts: Record<string, string> }).scripts);

    expect(scripts.filter((script) => pnpmCommands.includes(script))).toEqual([]);
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
