/**
 * Hexagonal boundary enforcement via ESLint (flat config).
 * Verified against eslint-plugin-boundaries@7.2.0 + eslint@9.
 *
 *   npm i -D eslint typescript-eslint eslint-plugin-boundaries \
 *            eslint-import-resolver-typescript
 *
 * Use this instead of dependency-cruiser when you want violations inline in the
 * editor and in the same lint run as everything else.
 *
 * Two settings are load-bearing and silently produce ZERO violations if omitted:
 *   1. `languageOptions.parser` — without a TS parser every file is a parse error.
 *   2. `settings["import/resolver"].typescript` — without it, extensionless TS
 *      imports do not resolve, every dependency is classified "unknown", and the
 *      policies never fire. A green run is not proof of a clean codebase; seed a
 *      deliberate violation once and confirm it is reported.
 *
 * Layout:
 *   src/domain/{model,service,event,exception}/
 *   src/application/usecase/
 *   src/application/port/{driving,driven}/
 *   src/infrastructure/adapter/driving/<name>/     web, messaging, ...
 *   src/infrastructure/adapter/driven/<name>/      persistence, payment, messaging, ...
 *   src/infrastructure/config/                     composition root
 */
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    settings: {
      "import/resolver": { typescript: { alwaysTryTypes: true } },
      "boundaries/elements": [
        { type: "domain", pattern: "src/domain/**" },
        { type: "port-driving", pattern: "src/application/port/driving/**" },
        { type: "port-driven", pattern: "src/application/port/driven/**" },
        { type: "usecase", pattern: "src/application/usecase/**" },
        // Two captures: `side` is driving|driven, `adapterName` is the leaf folder.
        // Together they identify one adapter uniquely.
        {
          type: "adapter",
          pattern: "src/infrastructure/adapter/*/*/**",
          capture: ["side", "adapterName"],
        },
        { type: "config", pattern: "src/infrastructure/config/**" },
      ],
    },
    rules: {
      // Deny by default. Allowed edges are enumerated below; anything not listed
      // is an error. An allow-by-default config silently permits every edge you
      // forget to name — never use one.
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            // Domain knows nothing but itself.
            {
              from: { element: { type: "domain" } },
              allow: { to: { element: { type: "domain" } } },
            },
            // Ports are pure interfaces over domain types. A port that imports a
            // use case has inverted the dependency the wrong way.
            {
              from: { element: { types: { anyOf: ["port-driving", "port-driven"] } } },
              allow: {
                to: {
                  element: { types: { anyOf: ["domain", "port-driving", "port-driven"] } },
                },
              },
            },
            // A use case implements a driving port and calls driven ports.
            {
              from: { element: { type: "usecase" } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ["domain", "port-driving", "port-driven", "usecase"] },
                  },
                },
              },
            },
            // Driving adapters (controllers, consumers) enter through driving
            // ports only — never a use case class, never a driven port.
            {
              from: { element: { type: "adapter", captured: { side: "driving" } } },
              allow: { to: { element: { types: { anyOf: ["domain", "port-driving"] } } } },
            },
            // Driven adapters (repositories, gateways, publishers) implement
            // driven ports only.
            {
              from: { element: { type: "adapter", captured: { side: "driven" } } },
              allow: { to: { element: { types: { anyOf: ["domain", "port-driven"] } } } },
            },
            // An adapter may import its own folder, but no other adapter — not a
            // sibling on the same side, and not one across the driving/driven line.
            // `{{from.captured.*}}` is v6+ template syntax; the older `${...}`
            // form still works but warns.
            {
              from: { element: { type: "adapter" } },
              allow: {
                to: {
                  element: {
                    type: "adapter",
                    captured: {
                      side: "{{from.captured.side}}",
                      adapterName: "{{from.captured.adapterName}}",
                    },
                  },
                },
              },
            },
            // The composition root wires everything, so it may see everything.
            // Nothing may import it — that is the `default: "disallow"` above,
            // since no policy ever names `config` as a target.
            {
              from: { element: { type: "config" } },
              allow: { to: { element: { type: "*" } } },
            },
          ],
        },
      ],

      // Third-party packages. `boundaries/dependencies` above governs first-party
      // elements only, so without this a domain entity may freely import an ORM —
      // exactly the leak that matters most.
      //
      // NOTE: v7 deprecates this rule in favour of a `to: { module: { origin:
      // "external" } }` policy inside `boundaries/dependencies`. It still works
      // and is still the form that demonstrably fires; if you migrate, seed a
      // violation and confirm the new policy reports it before trusting a green run.
      "boundaries/external": [
        "error",
        {
          default: "allow",
          rules: [
            { from: ["domain"], disallow: ["*"] },
            {
              from: ["usecase", "port-driving", "port-driven"],
              disallow: [
                "express",
                "fastify",
                "@nestjs/*",
                "typeorm",
                "prisma",
                "mongoose",
                "knex",
                "axios",
                "kafkajs",
                "stripe",
                "pg",
              ],
            },
          ],
        },
      ],

      // Exhaustiveness: a file matching no element, or a dependency on something
      // unclassifiable, is an error — so a fourth unpoliced layer cannot appear
      // by accident, and a broken resolver surfaces as errors instead of silence.
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
    },
  },
];
