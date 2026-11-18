import { Armadillo as clientArmadillo } from "./client.js";
import { defineBackend } from "./backend.js";

/**
 * Product-level namespace for backend code. The client subpath keeps the same
 * callable `Armadillo()` API without pulling backend composition into a
 * browser bundle.
 */
export const Armadillo = Object.assign(clientArmadillo, { backend: defineBackend });

export {
  app,
  ArmadilloFunctionError,
  auditLog,
  collector,
  composeMiddleware,
  customAuth,
  defineBackend,
  defineFunction,
  defineExtension,
  rateLimit,
  retry,
  requiredSecrets,
  secret,
  validateInput,
} from "./backend.js";
export type {
  ArmadilloBackendDefinition,
  ArmadilloDiscovery,
  FunctionDescription,
  OpenApiDocument,
  ArmadilloAuthProvider,
  ArmadilloExternalAuthContext,
  ArmadilloExternalIdentity,
  ArmadilloFunctionContext,
  ArmadilloRecord,
  ArmadilloRecordAccess,
  ArmadilloCallerFiles,
  ArmadilloFunctionContract,
  ArmadilloFunctionDefinition,
  ArmadilloFunctionParser,
  ArmadilloFunctionValidator,
  ArmadilloLogger,
  ArmadilloTelemetry,
  ArmadilloSpan,
  ArmadilloLogEvent,
  ArmadilloLogLevel,
  ArmadilloRegisteredApp,
  ArmadilloSecret,
  ArmadilloSecretRequirement,
  ArmadilloSecretMap,
  ArmadilloStandardSchema,
  ArmadilloStandardSchemaIssue,
  ArmadilloStandardSchemaResult,
  SecretEnvironment,
} from "./backend.js";
export * from "./client.js";
export * from "./cache.js";
export * from "./computed.js";
export * from "./geo.js";
export * from "./middleware.js";
export * from "./realtime.js";
export * from "./realtime-client.js";
export * from "./schema.js";
export * from "./schema-migrations.js";
export * from "./webhooks.js";
export * from "./schedules.js";
export * from "./extensions.js";
export * from "./gdpr.js";
export * from "./ui.js";

export * from "./migrations.js";
export * from "./versions.js";

export {
  buildPromptPack,
  isStructureDiscoveryEnabled,
  renderFrameworkLlmsSections,
  renderPromptPackMarkdown,
  REST_CATALOG,
} from "./prompt-pack.js";
export type { ArmadilloDiscoveryConfig, ArmadilloPromptPack } from "./prompt-pack.js";
