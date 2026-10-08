import { withDiscovery } from "./discovery.js";
import { buildPromptPack } from "./prompt-pack.js";
import { buildPromptPack as buildPromptPack2, isStructureDiscoveryEnabled, renderFrameworkLlmsSections, renderPromptPackMarkdown, REST_CATALOG } from "./prompt-pack.js";
import {
  SchemaValidationError,
  validateFieldMapData
} from "./schema.js";
import { isRealtimeChannel } from "./realtime.js";
import { validateWebhookDefinitions } from "./webhooks.js";
import { validateGdprConfig } from "./gdpr.js";
import { validateUi } from "./ui.js";
import { validateUsageConfig } from "./usage-config.js";
import { validateScheduleDefinitions } from "./schedules.js";
class ArmadilloFunctionError extends Error {
  constructor(status, code, message, fields, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.hint = hint;
    this.name = "ArmadilloFunctionError";
  }
  status;
  code;
  fields;
  hint;
}
function customAuth(provider) {
  const id = provider.id?.trim();
  if (!id) throw new TypeError("customAuth needs a stable provider id.");
  if (typeof provider.authenticate !== "function") {
    throw new TypeError("customAuth needs an authenticate function.");
  }
  if (provider.defaultScopes !== void 0 && (!Array.isArray(provider.defaultScopes) || provider.defaultScopes.length === 0)) {
    throw new TypeError("customAuth defaultScopes must be a non-empty list when present.");
  }
  return Object.freeze({
    id,
    authenticate: provider.authenticate,
    ...provider.allowBuiltInCredentials === void 0 ? {} : { allowBuiltInCredentials: provider.allowBuiltInCredentials },
    ...provider.defaultScopes === void 0 ? {} : { defaultScopes: Object.freeze([...provider.defaultScopes]) }
  });
}
function isFunctionValidator(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return "~standard" in candidate || typeof candidate.parse === "function";
}
function functionContract(value) {
  return isFunctionValidator(value) ? { kind: "validator", validator: value } : { kind: "fields", fields: value };
}
function functionValidationError(direction, fields) {
  return direction === "input" ? new ArmadilloFunctionError(422, "VALIDATION_ERROR", "Function input is invalid.", fields) : new ArmadilloFunctionError(500, "INTERNAL_ERROR", "Function output does not match its contract.", fields);
}
async function validateFunctionContract(contract, value, direction) {
  if (!contract) return value;
  if (contract.kind === "fields") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw functionValidationError(direction, { data: "Expected an object" });
    }
    try {
      return validateFieldMapData(contract.fields, value, false);
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        throw functionValidationError(direction, error.fields);
      }
      throw error;
    }
  }
  const validator = contract.validator;
  try {
    if ("~standard" in validator) {
      const result = await validator["~standard"].validate(value);
      if (result.issues) {
        const fields = Object.fromEntries(result.issues.map((issue, index) => [
          issue.path?.map(String).join(".") || `data.${index}`,
          issue.message
        ]));
        throw functionValidationError(direction, fields);
      }
      return result.value;
    }
    return await validator.parse(value);
  } catch (error) {
    if (error instanceof ArmadilloFunctionError) throw error;
    const message = error instanceof Error ? error.message : "Validation failed";
    throw functionValidationError(direction, { data: message });
  }
}
function validateFunctionInput(definition, data) {
  return validateFunctionContract(definition.input, data, "input");
}
async function validateFunctionOutput(definition, value) {
  const output = await validateFunctionContract(definition.output, value, "output");
  if (output === void 0) return output;
  try {
    JSON.stringify(output);
  } catch {
    throw functionValidationError("output", { data: "Expected a JSON-serializable value" });
  }
  return output;
}
class ArmadilloFunctionBuilder {
  constructor(inputContract = void 0, outputContract = void 0, description = void 0, authorizeRule = void 0, middlewareList = [], useTransaction = false, authorityLevel = void 0, publicAccess = false) {
    this.inputContract = inputContract;
    this.outputContract = outputContract;
    this.description = description;
    this.authorizeRule = authorizeRule;
    this.middlewareList = middlewareList;
    this.useTransaction = useTransaction;
    this.authorityLevel = authorityLevel;
    this.publicAccess = publicAccess;
  }
  inputContract;
  outputContract;
  description;
  authorizeRule;
  middlewareList;
  useTransaction;
  authorityLevel;
  publicAccess;
  /** Require caller membership before the handler runs. Members without a listed role get 403. */
  authorize(auth) {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      auth,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess
    );
  }
  /** Run middleware around the handler, after authorization. Calls append in order. */
  middleware(...handlers) {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      [...this.middlewareList, ...handlers],
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess
    );
  }
  /** Run the handler inside a provider-native transaction. Adapters without one reject before running. */
  transaction() {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      true,
      this.authorityLevel,
      this.publicAccess
    );
  }
  /**
   * Grant raw SQL, storage, and administration through context.trusted.
   * A trusted function must declare its caller model or registration refuses
   * it: .authorize({ group: "<slug>" }) restricts callers to a trusted
   * group; .public() declares any authenticated caller may invoke, with the
   * handler as the sole authorization layer (for caller sets no group rule
   * can express — never a substitute for a group you could have honestly
   * named).
   */
  trusted() {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      "trusted",
      this.publicAccess
    );
  }
  /**
   * Declare that any AUTHENTICATED caller may invoke this trusted function,
   * with the handler as the sole authorization layer. Use only for caller
   * sets no group rule can express: pre-membership invite redeem,
   * owner-scoped personal products, and dynamic per-instance groups. NEVER a
   * substitute for a group you could have honestly named. NEVER anonymous:
   * authentication still runs before any authorization check. A trusted
   * function with neither .authorize() nor .public() is refused at
   * registration; declaring both throws at defineBackend.
   */
  public() {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      true
    );
  }
  input(contract) {
    return new ArmadilloFunctionBuilder(
      functionContract(contract),
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess
    );
  }
  output(contract) {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      functionContract(contract),
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess
    );
  }
  describe(description) {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      typeof description === "string" ? { summary: description } : description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess
    );
  }
  handler(handler) {
    return {
      ...this.description ? { description: this.description } : {},
      ...this.authorizeRule ? { authorize: this.authorizeRule } : {},
      ...this.publicAccess ? { public: true } : {},
      ...this.middlewareList.length > 0 ? { middleware: this.middlewareList } : {},
      ...this.useTransaction ? { transaction: true } : {},
      ...this.authorityLevel ? { authority: this.authorityLevel } : {},
      ...this.inputContract ? { input: this.inputContract } : {},
      ...this.outputContract ? { output: this.outputContract } : {},
      handler
    };
  }
}
function defineFunction() {
  return new ArmadilloFunctionBuilder();
}
function secret(name, options = {}) {
  return Object.freeze({
    __armadilloSecret: true,
    ...name ? { name } : {},
    ...options.description ? { description: options.description } : {},
    ...options.required === void 0 ? {} : { required: options.required }
  });
}
function app(definition) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(definition.id)) {
    throw new TypeError("Registered app ids must start with a letter and use letters, numbers, _ or -.");
  }
  if (!definition.name.trim() || definition.name.length > 120) {
    throw new TypeError("Registered app names must use 1 to 120 characters.");
  }
  for (const [resource, actions] of Object.entries(definition.capabilities ?? {})) {
    if (!/^(?:\*|[A-Za-z][A-Za-z0-9_-]{0,62}(?::[A-Za-z][A-Za-z0-9_-]{0,62})?)$/.test(resource) || actions.length === 0 || actions.some((action) => !/^(?:\*|[A-Za-z][A-Za-z0-9:_-]{0,95})$/.test(action))) {
      throw new TypeError(`Registered app capability \`${resource}\` is invalid.`);
    }
  }
  for (const origin of definition.origins ?? []) {
    if (origin === "self" || origin === "http://localhost:*" || origin === "http://127.0.0.1:*") continue;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:" || parsed.origin !== origin) throw new Error();
    } catch {
      throw new TypeError(`Registered app origin \`${origin}\` must be an exact HTTP origin.`);
    }
  }
  return definition;
}
function requiredSecrets(definition) {
  const requirements = /* @__PURE__ */ new Map();
  const add = (requirement) => {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(requirement.name)) {
      throw new TypeError(`Application secret \`${requirement.name}\` is invalid.`);
    }
    const existing = requirements.get(requirement.name);
    if (existing && (existing.required !== requirement.required || existing.description !== requirement.description)) {
      throw new TypeError(`Conflicting application secret requirement: \`${requirement.name}\`.`);
    }
    requirements.set(requirement.name, requirement);
  };
  for (const [key, value] of Object.entries(definition.secrets ?? {})) {
    if (value.__armadilloSecret !== true) throw new TypeError(`Secret \`${key}\` must use secret().`);
    add({
      name: value.name ?? key,
      ...value.description ? { description: value.description } : {},
      required: value.required !== false
    });
  }
  for (const extension of definition.extensions ?? []) {
    for (const requirement of extension.requirements?.secrets ?? []) {
      add({
        name: requirement.name,
        ...requirement.description ? { description: requirement.description } : {},
        required: requirement.required !== false
      });
    }
  }
  for (const webhook of Object.values(definition.webhooks ?? {})) {
    if (typeof webhook.secret !== "string") {
      const value = webhook.secret;
      if (!value.name) throw new TypeError("Webhook secrets need an explicit name.");
      add({ name: value.name, required: true, ...value.description ? { description: value.description } : {} });
    }
  }
  return [...requirements.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function collector(definition) {
  if (Object.keys(definition.fields).length === 0) throw new TypeError("Collectors need at least one field.");
  if (Object.values(definition.fields).some((field) => field.config.type === "file")) {
    throw new TypeError("Collector file fields are not supported yet; upload through the authenticated Files API.");
  }
  if (definition.retentionDays !== void 0 && (!Number.isSafeInteger(definition.retentionDays) || definition.retentionDays < 1 || definition.retentionDays > 3650)) {
    throw new TypeError("Collector retentionDays must be an integer from 1 to 3,650.");
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(definition.access.team)) {
    throw new TypeError("Collector access.team must be a valid team slug.");
  }
  if (definition.model !== void 0 && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.model)) {
    throw new TypeError("Collector model must start with a letter and use letters, numbers, _ or -.");
  }
  if (definition.access.roles?.length === 0 || definition.access.roles?.some((role) => !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) {
    throw new TypeError("Collector access.roles must contain valid team roles.");
  }
  if (definition.expiresAt !== void 0 && !Number.isFinite(Date.parse(definition.expiresAt))) {
    throw new TypeError("Collector expiresAt must be an ISO-compatible timestamp.");
  }
  return definition;
}
function assertTrustedAuthorized(functions) {
  for (const [name, fn] of Object.entries(functions)) {
    if (fn.authorize && fn.public) {
      throw new TypeError(
        `Dillo security: function "${name}" declares both .authorize() and .public(): a function has one caller model \u2014 a named group, or any authenticated caller with the handler as the sole authorization layer. Choose one.`
      );
    }
    if (fn.authority === "trusted" && !fn.authorize && !fn.public) {
      throw new TypeError(
        `Dillo security: function "${name}" registers authority: "trusted" without an authorize() rule or a .public() declaration, so any holder of the functions:${name} API scope could invoke it with raw capabilities. Add .authorize({ group: "<slug>" }) to restrict callers to a trusted group, or .public() to declare any authenticated caller may invoke, with the handler as the sole authorization layer.`
      );
    }
  }
}
function defineBackend(definition) {
  validateWebhookDefinitions(definition.webhooks);
  validateUsageConfig(definition.usage);
  validateScheduleDefinitions(
    definition.schedules,
    new Set(Object.keys(definition.functions ?? {}))
  );
  validateGdprConfig(definition.gdpr);
  validateUi(definition.ui);
  if (definition.files === false && Object.values(definition.ui?.apps ?? {}).some((app2) => app2.requires?.includes("files"))) {
    throw new TypeError("The UI requires files, but this backend disables file storage.");
  }
  requiredSecrets(definition);
  for (const channel of definition.realtime?.channels ?? []) {
    if (!isRealtimeChannel(channel) || channel.startsWith("table:")) {
      throw new TypeError(`Realtime channel \`${channel}\` is invalid or reserved.`);
    }
  }
  if (!definition.extensions?.length) return (() => {
    assertTrustedAuthorized(definition.functions ?? {});
    const discovered = withDiscovery(definition);
    return Object.assign(discovered, {
      promptPack: (options) => buildPromptPack(discovered, options)
    });
  })();
  const extensions = definition.extensions;
  const names = /* @__PURE__ */ new Set();
  for (const extension of extensions) {
    if (names.has(extension.name)) throw new TypeError(`Duplicate extension: \`${extension.name}\`.`);
    names.add(extension.name);
  }
  const merge = (label, entries) => {
    const output = /* @__PURE__ */ Object.create(null);
    for (const entry of entries) {
      for (const [name, value] of Object.entries(entry ?? {})) {
        if (Object.hasOwn(output, name)) {
          throw new TypeError(`Duplicate ${label} contribution: \`${name}\`.`);
        }
        output[name] = value;
      }
    }
    return output;
  };
  const functions = merge(
    "function",
    [...extensions.map((extension) => extension.functions), definition.functions]
  );
  assertTrustedAuthorized(functions);
  const extensionListeners = definition.extensions.map((extension) => extension.listener).filter((listener) => listener !== void 0);
  const applicationListener = definition.listeners?.request;
  const middleware = [
    ...extensions.flatMap((extension) => extension.middleware ?? []),
    ...definition.middleware ?? []
  ];
  return (() => {
    const discovered = withDiscovery({
      ...definition,
      functions,
      apps: merge("app", [...extensions.map((extension) => extension.apps), definition.apps]),
      collectors: merge(
        "collector",
        [...extensions.map((extension) => extension.collectors), definition.collectors]
      ),
      middleware,
      listeners: {
        ...definition.listeners,
        async request(context) {
          for (const listener of extensionListeners) {
            const response = await listener(context);
            if (response) return response;
          }
          return applicationListener?.(context);
        }
      }
    });
    return Object.assign(discovered, {
      promptPack: (options) => buildPromptPack(discovered, options)
    });
  })();
}
import { auditLog, composeMiddleware, rateLimit, retry, validateInput } from "./middleware.js";
import { defineExtension } from "./extensions.js";
export * from "./internal-schema.js";
export {
  ArmadilloFunctionBuilder,
  ArmadilloFunctionError,
  REST_CATALOG,
  app,
  auditLog,
  buildPromptPack2 as buildPromptPack,
  collector,
  composeMiddleware,
  customAuth,
  defineBackend,
  defineExtension,
  defineFunction,
  isStructureDiscoveryEnabled,
  rateLimit,
  renderFrameworkLlmsSections,
  renderPromptPackMarkdown,
  requiredSecrets,
  retry,
  secret,
  validateFunctionInput,
  validateFunctionOutput,
  validateInput
};
