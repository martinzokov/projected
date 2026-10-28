/**
 * @projected/architecture — the rules that keep a projected app hexagonal, enforced by the
 * compiler (per-layer tsconfig presets), dependency-cruiser and ESLint rather than by convention.
 */
export { checkArchitecture, formatViolations, type CheckOptions, type CheckReport } from "./check.js";
export { checkLayout, type Violation } from "./layout.js";
export {
  FLAVOURS,
  dependencyCruiserConfig,
  dependencyCruiserRules,
  type DependencyCruiserOptions,
  type Flavour,
} from "./dependency-cruiser.js";
export {
  DESIGN_RULE_DEFAULTS,
  projectedEslint,
  projectedPlugin,
  type DesignRules,
  type EslintOptions,
  type RuleLevel,
} from "./eslint.js";
