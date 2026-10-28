export { run } from "./cli.js";
export { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
export {
  LOCKFILE_VERSION,
  compareLock,
  fingerprint,
  lockOf,
  operationKey,
  updateLock,
  type ContractsLock,
  type LockComparison,
} from "./contracts-lock.js";
export { loadContracts, loadProject, type Project, type ProjectConfig, type VendorConfig } from "./project.js";
export { vendorAdd, vendorCheck, vendorGenerate, vendorUpdate } from "./vendor/commands.js";
export { compareSpecs, type SpecChange } from "./vendor/diff.js";
export { generateClient, vendorPaths } from "./vendor/generate.js";
export { canonicalSpec, parseSpec, specHash, type OpenApiDocument } from "./vendor/spec.js";
