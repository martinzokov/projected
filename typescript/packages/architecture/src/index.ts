/**
 * @projected/architecture — the rules that keep a projected app hexagonal, enforced by the
 * compiler (per-layer tsconfig presets), dependency-cruiser and ESLint rather than by convention.
 */
export { checkArchitecture, formatViolations, type CheckOptions, type CheckReport } from "./check.js";
export { checkLayout, type Violation } from "./layout.js";
export { dependencyCruiserConfig, dependencyCruiserRules, type DependencyCruiserOptions } from "./dependency-cruiser.js";
export { projectedEslint, type EslintOptions } from "./eslint.js";
