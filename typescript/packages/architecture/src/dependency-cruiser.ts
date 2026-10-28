import type { IConfiguration, IForbiddenRuleType } from "dependency-cruiser";

/**
 * Hexagonal boundary rules for a projected app, for dependency-cruiser.
 *
 * Derived from the validated TypeScript config in martinzokov/anti-slop
 * (skills/hexagonal-architecture-enforcement/configs/dependency-cruiser.js), with the same layout:
 *
 *   src/domain/                                  aggregates, events, decisions, business errors
 *   src/application/port/driving/                commands, queries, contracts (what the app offers)
 *   src/application/port/driven/                 app-specific outbound ports (what the app needs)
 *   src/application/usecase/                     handlers, projections, policies
 *   src/infrastructure/adapter/(driving|driven)/<name>/
 *   src/infrastructure/config/                   composition root
 *
 * What projected changes: the domain and application layers may import exactly one framework
 * package each — the pure kernels `@projected/domain` and `@projected/application` — and no
 * other package at all. Every adapter package is infrastructure-only.
 *
 * Messages are written as instructions to whoever (or whatever agent) hits the rule.
 */

/** How a project stores its aggregates. Chosen when the project is created; it never changes. */
export type Flavour = "event-sourced" | "state-based";
export const FLAVOURS: readonly Flavour[] = ["event-sourced", "state-based"];

export interface DependencyCruiserOptions {
  /** The project's flavour. When set, the other flavour's entry points are off limits. */
  readonly flavour?: Flavour;
  /** Extra npm packages the application layer may import, e.g. `["date-fns"]`. Pure libraries only. */
  readonly applicationPackages?: readonly string[];
  /** Extra npm packages the domain layer may import. Think twice. */
  readonly domainPackages?: readonly string[];
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Matches a package whether it resolved (through node_modules) or not. */
const pkg = (name: string) => [`(^|/)node_modules/${escape(name)}/`, `^${escape(name)}(/|$)`];

export function dependencyCruiserRules(options: DependencyCruiserOptions = {}): IForbiddenRuleType[] {
  const domainAllowed = ["^src/domain/", ...pkg("@projected/domain"), ...(options.domainPackages ?? []).flatMap(pkg)];
  const applicationAllowed = [
    "^src/(domain|application)/",
    ...pkg("@projected/domain"),
    ...pkg("@projected/application"),
    ...(options.applicationPackages ?? []).flatMap(pkg),
  ];

  const flavourRules: IForbiddenRuleType[] = [];
  if (options.flavour !== undefined) {
    const other = FLAVOURS.find((f) => f !== options.flavour) ?? options.flavour;
    flavourRules.push({
      name: "one-flavour",
      comment:
        `This project is ${options.flavour} (\`flavour\` in projected.json), so the ${other} APIs are not available ` +
        `to it: a project's flavour is fixed when it is created. Import from @projected/<package>/${options.flavour} ` +
        "or the package's shared entry point instead.",
      severity: "error",
      from: {},
      to: { path: [`(^|/)node_modules/@projected/[^/]+/(dist|src)/${other}/`, `^@projected/[^/]+/${other}($|/)`] },
    });
  }

  return [
    ...flavourRules,
    {
      name: "domain-is-pure",
      comment:
        "src/domain may only import src/domain and @projected/domain. No application, no infrastructure, no other " +
        "npm packages, no node builtins. If a decision needs the time, an id or data from elsewhere, take it as an " +
        "argument and let the use case provide it.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: domainAllowed },
    },
    {
      name: "application-not-infrastructure",
      comment:
        "src/application must not import src/infrastructure. Declare a port in src/application/port/driven and let " +
        "an adapter in src/infrastructure/adapter/driven implement it.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "^src/infrastructure/" },
    },
    {
      name: "application-only-uses-the-kernel",
      comment:
        "src/application may import only src/domain, src/application, @projected/domain and @projected/application. " +
        "HTTP, messaging, databases and the clock are reached through ports; their adapters are wired in " +
        "src/infrastructure/config. To call another service, depend on its contracts through RemoteService.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { pathNot: [...applicationAllowed, "^src/infrastructure/"] },
    },
    {
      name: "ports-are-pure-interfaces",
      comment:
        "A port may only reference the domain, other ports and the projected kernels. If a port imports a use case, " +
        "the dependency points the wrong way — the use case implements the driving port, not the other way round.",
      severity: "error",
      from: { path: "^src/application/port/" },
      to: {
        pathNot: ["^src/application/port/", "^src/domain/", ...pkg("@projected/domain"), ...pkg("@projected/application")],
      },
    },
    {
      name: "driving-adapters-use-driving-ports",
      comment:
        "A driving adapter (controller, consumer) may only call the application through src/application/port/driving. " +
        "Importing a use case directly couples the transport to the implementation; importing a driven port is upside down. " +
        "Usually you need no driving adapter at all: @projected/http and @projected/messaging serve the contracts.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driving/" },
      to: { path: "^src/application/(usecase|port/driven)/" },
    },
    {
      name: "driven-adapters-implement-driven-ports",
      comment:
        "A driven adapter (repository, gateway, publisher) implements a port from src/application/port/driven. It must " +
        "not import use cases or driving ports — an adapter that calls back into the application is a cycle in disguise.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driven/" },
      to: { path: "^src/application/(usecase|port/driving)/" },
    },
    {
      name: "adapters-are-independent",
      comment:
        "An adapter may not import another adapter — not across driving/driven, and not a sibling on the same side. " +
        "Route the call through a use case, or through a port both adapters know.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/(driving|driven)/([^/]+)/" },
      // $1 = side, $2 = adapter name. Together they mean 'any adapter but my own'.
      to: {
        path: "^src/infrastructure/adapter/(driving|driven)/([^/]+)/",
        pathNot: "^src/infrastructure/adapter/$1/$2/",
      },
    },
    {
      name: "nothing-imports-config",
      comment:
        "src/infrastructure/config is the composition root. It wires the application together; nothing in src may " +
        "import it. If you need something from it, have it injected instead. (Tests may: they build the real app.)",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/infrastructure/config/" },
      to: { path: "^src/infrastructure/config/" },
    },
    {
      name: "test-code-stays-in-tests",
      comment: "Production code must not import test helpers. Move fakes to test/, or make them real adapters.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: [...pkg("@projected/testing"), ...pkg("vitest"), "^test/"] },
    },
    {
      name: "known-layers-only",
      comment:
        "Every source file belongs to a layer: src/domain, src/application/(port/driving|port/driven|usecase), " +
        "src/infrastructure/adapter/(driving|driven)/<name> or src/infrastructure/config. Move this file into one.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot:
          "^src/(domain/|application/(port/(driving|driven)|usecase)/|infrastructure/(adapter/(driving|driven)/[^/]+/|config/))",
      },
      to: {},
    },
    {
      name: "no-circular",
      comment: "Cycles make layer rules meaningless. Break the cycle with a port.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "This import does not resolve. Fix the path, or add the package as a dependency.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^@projected/" },
    },
  ];
}

/** A complete dependency-cruiser configuration for a projected app. */
export function dependencyCruiserConfig(options: DependencyCruiserOptions = {}): IConfiguration {
  return {
    forbidden: dependencyCruiserRules(options),
    options: {
      // Follow `import type` too — a type-only import of an adapter is still a breach.
      tsPreCompilationDeps: true,
      tsConfig: { fileName: "tsconfig.json" },
      // Keep `node_modules/@projected/x` paths stable whether packages are linked or installed.
      preserveSymlinks: true,
      doNotFollow: { path: "node_modules" },
      // Only the project's own build output. Installed packages live in node_modules/<pkg>/dist,
      // and excluding those would drop every import of them — and every rule about it.
      exclude: { path: "^(dist|\\.tsbuild)/" },
    },
  };
}
