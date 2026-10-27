/**
 * Hexagonal boundary enforcement for TypeScript.
 * Run: npx depcruise src --config .dependency-cruiser.js
 * Requires `typescript` installed in the project — see note at the bottom.
 *
 * Layout:
 *   src/domain/{model,service,event,exception}/
 *   src/application/usecase/
 *   src/application/port/{driving,driven}/
 *   src/infrastructure/adapter/driving/<name>/     web, messaging, ...
 *   src/infrastructure/adapter/driven/<name>/      persistence, payment, messaging, ...
 *   src/infrastructure/config/                     composition root
 */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment:
        "src/domain may only import from src/domain. No application, no infrastructure, " +
        "no npm packages, no node builtins. If you need the clock, a UUID, or persistence, " +
        "take it as an argument or declare a driven port in src/application/port/driven.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "application-not-infrastructure",
      comment:
        "src/application must not import src/infrastructure. Declare a port in " +
        "src/application/port/driven and let the adapter implement it.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "^src/infrastructure/" },
    },
    {
      name: "ports-are-pure-interfaces",
      comment:
        "A port may only reference the domain and other ports. If a port imports a use " +
        "case, the dependency has inverted the wrong way — the use case implements the " +
        "driving port, not the other way round.",
      severity: "error",
      from: { path: "^src/application/port/" },
      to: { pathNot: "^(src/application/port/|src/domain/)" },
    },
    {
      name: "application-no-frameworks",
      comment:
        "Use cases and ports must not depend on transport or persistence frameworks. " +
        "Convert at the adapter edge.",
      severity: "error",
      from: { path: "^src/application/" },
      to: {
        dependencyTypes: ["npm"],
        path: "express|fastify|@nestjs|typeorm|prisma|mongoose|knex|axios|kafkajs|stripe|pg",
      },
    },
    {
      name: "driving-adapters-use-driving-ports",
      comment:
        "A driving adapter (controller, consumer) may only call the application through " +
        "src/application/port/driving. Importing a use case class directly couples the " +
        "transport to the implementation; importing a driven port is upside down.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driving/" },
      to: { path: "^src/application/(usecase|port/driven)/" },
    },
    {
      name: "driven-adapters-implement-driven-ports",
      comment:
        "A driven adapter (repository, gateway, publisher) implements a port from " +
        "src/application/port/driven. It must not import use cases or driving ports — " +
        "an adapter that calls back into the application is a cycle in disguise.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driven/" },
      to: { path: "^src/application/(usecase|port/driving)/" },
    },
    {
      name: "adapters-are-independent",
      comment:
        "An adapter may not import another adapter — not across driving/driven, and not " +
        "a sibling on the same side. Route the call through a use case, or through a port " +
        "both adapters know.",
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
        "src/infrastructure/config is the composition root. It wires the application " +
        "together; nothing may import it. If you need something from it, you need it " +
        "injected instead.",
      severity: "error",
      from: { pathNot: "^src/infrastructure/config/" },
      to: { path: "^src/infrastructure/config/" },
    },
    {
      name: "no-circular",
      comment: "Cycles make layer rules meaningless. Break the cycle with a port.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Follow `import type` too — a type-only import of an adapter is still a breach.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};

/*
 * IMPORTANT: `npm i -D typescript` must be present in the project. Without a
 * TypeScript compiler, dependency-cruiser silently cruises 0 modules and prints
 * "no dependency violations found" — a green check that enforces nothing.
 * Seed a violation once and confirm this config goes red before trusting it.
 */
