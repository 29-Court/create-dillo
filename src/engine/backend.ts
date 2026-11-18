import { withDiscovery, type ArmadilloDiscovery, type FunctionDescription } from "./discovery.js";
import { buildPromptPack, type ArmadilloDiscoveryConfig, type ArmadilloPromptPack } from "./prompt-pack.js";
export type { ArmadilloDiscovery, FunctionDescription, OpenApiDocument } from "./discovery.js";
export type { ArmadilloDiscoveryConfig, ArmadilloPromptPack } from "./prompt-pack.js";
export { buildPromptPack, isStructureDiscoveryEnabled, renderFrameworkLlmsSections, renderPromptPackMarkdown, REST_CATALOG } from "./prompt-pack.js";
import {
  SchemaValidationError,
  validateFieldMapData,
  type FieldMap,
  type FieldMapInput,
  type SchemaDefinition,
} from "./schema.js";
import type { Middleware } from "./middleware.js";
import type { RealtimeConfig } from "./realtime.js";
import { isRealtimeChannel } from "./realtime.js";
import type { WebhookDefinition } from "./webhooks.js";
import { validateWebhookDefinitions } from "./webhooks.js";
import type { ArmadilloExtension, ExtensionEnvironmentOf } from "./extensions.js";
import type { ArmadilloGdprConfig } from "./gdpr.js";
import { validateGdprConfig } from "./gdpr.js";
import { validateUi, type ArmadilloUi } from "./ui.js";
import { validateUsageConfig } from "./usage-config.js";
import { validateScheduleDefinitions, type ScheduleDefinition } from "./schedules.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

/** Structured levels intentionally shared by every Dillo runtime. */
export type ArmadilloLogLevel = "debug" | "info" | "warn" | "error";

/**
 * A portable, JSON-safe event. Dillo enriches application events with
 * request and function context; a logger can add service-wide fields or send
 * it to stdout, a collector, or an organization-owned pipeline.
 */
export interface ArmadilloLogEvent {
  timestamp: string;
  level: ArmadilloLogLevel;
  event: string;
  appId?: string;
  stage?: string;
  requestId?: string;
  /** OpenTelemetry-style trace id of the current operation span, when the engine provides one. Joins logs to telemetry spans. */
  traceId?: string;
  /** Span id of the current operation span, when the engine provides one. */
  spanId?: string;
  functionName?: string;
  actorId?: string;
  attributes?: JsonObject;
}

/**
 * The only logging contract adapters need. It deliberately has no vendor
 * dependency: JSON logs work with a platform log drain, Splunk, ClickHouse,
 * OpenTelemetry collectors, or a project-local sink.
 */
export interface ArmadilloLogger {
  write(event: ArmadilloLogEvent): void | Promise<void>;
}

/** Completed diagnostic span. No inputs, credentials or error messages are captured. */
export interface ArmadilloSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/** Enqueue spans synchronously. The host owns exporting, flushing and retention. */
export interface ArmadilloTelemetry {
  span(span: ArmadilloSpan): void;
}

export type ArmadilloBackendErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STRUCTURE_DISCOVERY_DISABLED"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/** A predictable application error that every transport adapter can serialize. */
export class ArmadilloFunctionError extends Error {
  constructor(
    readonly status: number,
    readonly code: ArmadilloBackendErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
    /** Actionable guidance for the developer or agent. Never contains credentials. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ArmadilloFunctionError";
  }
}

/** The small SQL surface available to application functions on every adapter. */
export interface ArmadilloStatement {
  bind(...values: unknown[]): ArmadilloStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface ArmadilloDatabase {
  prepare(query: string): ArmadilloStatement;
  /** Execute buffered writes atomically when the adapter supports batching. */
  batch?(statements: readonly ArmadilloStatement[]): Promise<unknown[]>;
  /** Run arbitrary reads and writes on one provider-native transaction. */
  transaction?<T>(handler: (database: ArmadilloDatabase) => Promise<T>): Promise<T>;
}

export interface ArmadilloStoredFile {
  body: ReadableStream;
  size: number;
  etag: string;
}

/**
 * Portable file capabilities exposed to application functions. Uploads normally
 * go through Dillo's authenticated Files API, keeping provider-specific put
 * options out of application code.
 */
export interface ArmadilloFileStorage {
  get(key: string): Promise<ArmadilloStoredFile | null>;
  delete(key: string): Promise<void>;
}

/** File IDs authorized as the current caller; unavailable IDs throw a not-found error. */
export interface ArmadilloCallerFiles {
  get(id: string): Promise<ArmadilloStoredFile>;
  delete(id: string): Promise<void>;
}

export interface ArmadilloPrincipal {
  id: string;
  email: string;
  name: string | null;
}

export interface ArmadilloRequestPrincipal {
  type: "user" | "api_key";
  /** User id for sessions, API-key id for machine requests. */
  id: string;
  name: string | null;
  scopes: readonly string[];
}

/** A verified person supplied by an authentication system outside Dillo. */
export interface ArmadilloExternalIdentity {
  /** Stable provider-specific subject. It is never inferred from an email address. */
  subject: string;
  /** A verified, current email address for the person. */
  email: string;
  name?: string | null;
  /** Optional provider scopes. Omit for the normal application-user authority. */
  scopes?: readonly string[];
}

/** What an external authentication implementation receives for each request. */
export interface ArmadilloExternalAuthContext {
  request: Request;
  appId: string;
  /** The adapter runtime, deliberately left provider-neutral. */
  runtime: unknown;
}

/**
 * Bring any authentication system into Dillo without waiting for an
 * integration package. Return a verified identity, or `null` when this
 * request is not authenticated by that system.
 */
export interface ArmadilloAuthProvider {
  /** A stable name, used to keep identity namespaces separate. */
  id: string;
  /** Explicit migration/interop opt-in; otherwise the provider is authoritative. */
  allowBuiltInCredentials?: boolean;
  /**
   * Scopes granted to an identity that does not declare its own. Defaults to
   * none: an unscoped external identity is authenticated but powerless until
   * the provider opts in here.
   */
  defaultScopes?: readonly string[];
  authenticate(
    context: ArmadilloExternalAuthContext,
  ): Promise<ArmadilloExternalIdentity | null | undefined> | ArmadilloExternalIdentity | null | undefined;
}

/** A tiny helper that makes an external auth provider explicit in backend code. */
export function customAuth(provider: ArmadilloAuthProvider): ArmadilloAuthProvider {
  const id = provider.id?.trim();
  if (!id) throw new TypeError("customAuth needs a stable provider id.");
  if (typeof provider.authenticate !== "function") {
    throw new TypeError("customAuth needs an authenticate function.");
  }
  if (provider.defaultScopes !== undefined
    && (!Array.isArray(provider.defaultScopes) || provider.defaultScopes.length === 0)) {
    throw new TypeError("customAuth defaultScopes must be a non-empty list when present.");
  }
  // Preserve every declared capability. Copying only `id`/`authenticate` here
  // silently disabled `allowBuiltInCredentials` for every backend that used
  // this helper, which turned a migration window into a hard cutover.
  return Object.freeze({
    id,
    authenticate: provider.authenticate,
    ...(provider.allowBuiltInCredentials === undefined
      ? {}
      : { allowBuiltInCredentials: provider.allowBuiltInCredentials }),
    ...(provider.defaultScopes === undefined
      ? {}
      : { defaultScopes: Object.freeze([...provider.defaultScopes]) }),
  });
}

export interface ArmadilloGroupMembership {
  groupId: string;
  groupName: string;
  groupSlug: string;
  role: string;
  trusted: boolean;
}

export interface ArmadilloUserAdministration {
  /** Create a password-enabled user without creating a browser session. */
  create(input: { email: string; password: string; name?: string }): Promise<ArmadilloPrincipal>;
  /** Queue a rate-limited sign-in email without a network call back into the Worker. */
  requestMagicLink(input: { email: string; redirectTo?: string }): Promise<{ queued: true; debugToken?: string }>;
  /** Replace a user's password and revoke every existing session. */
  resetPassword(userId: string, newPassword: string): Promise<void>;
  /** Set the signed-in user's display name. */
  rename(name: string): Promise<{ name: string }>;
}

/** JSON record returned by the HTTP API, including its known system fields. */
export interface ArmadilloRecord extends JsonObject {
  id: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** Caller-scoped records; every operation uses the REST authorization policy. */
export interface ArmadilloRecordAccess {
  get(table: string, id: string): Promise<ArmadilloRecord>;
  create(table: string, data: JsonObject): Promise<ArmadilloRecord>;
  update(table: string, id: string, data: JsonObject): Promise<ArmadilloRecord>;
  delete(table: string, id: string): Promise<void>;
  query(table: string, query?: JsonObject): Promise<ArmadilloRecord[]>;
}

/** Schema-checked read of closed or caller-invisible rows. Field names come from the schema. */
export interface ArmadilloTrustedQuery {
  where?: JsonObject;
  contains?: Readonly<Record<string, string>>;
  compare?: ReadonlyArray<{ field: string; op: "lt" | "lte" | "gt" | "gte"; value: string | number }>;
  order?: ReadonlyArray<{ field: string; direction?: "asc" | "desc" }>;
  limit?: number;
}

/**
 * Insert only when the sum of `field` over rows matching `where`, plus this row,
 * does not exceed `source.field` on another record. One statement, so two callers
 * cannot both pass the check.
 */
export interface ArmadilloTrustedCapacity {
  field: string;
  where: JsonObject;
  source: { table: string; id: string; field: string };
  conflict?: string;
}

export interface ArmadilloTrustedCreateOptions {
  ownerId?: string;
  capacity?: ArmadilloTrustedCapacity;
}

export interface ArmadilloTrustedPatchWhereOptions {
  /**
   * Required when `where` is empty. An empty filter matches every row in the
   * collection, so without this flag a missing condition silently becomes a
   * table-wide rewrite.
   */
  all?: boolean;
  /** Page size for an unfiltered `{ all: true }` patch. Defaults to 100. */
  limit?: number;
  /** Rows to skip before applying an unfiltered `{ all: true }` patch. */
  offset?: number;
}

export type ArmadilloTrustedBatchStep =
  | { create: { table: string; data: JsonObject; ownerId?: string } }
  | { patchWhere: { table: string; where: JsonObject; data: JsonObject; options?: ArmadilloTrustedPatchWhereOptions } };

/** Schema-validated writes that skip the caller's record policy. The handler still authorizes the action. */
export interface ArmadilloTrustedRecords {
  get(table: string, id: string): Promise<ArmadilloRecord>;
  query(table: string, query?: ArmadilloTrustedQuery): Promise<ArmadilloRecord[]>;
  create(table: string, data: JsonObject, options?: ArmadilloTrustedCreateOptions): Promise<ArmadilloRecord>;
  update(table: string, id: string, data: JsonObject): Promise<ArmadilloRecord>;
  /**
   * Apply `data` to the rows whose current fields match `where`.
   *
   * An empty `where` matches the whole collection and is refused unless the
   * caller passes `{ all: true }`, which also requires the patch to assign one
   * fixed value and applies it in bounded pages. `changed` is the number of rows
   * the database reports as updated.
   */
  patchWhere(
    table: string,
    where: JsonObject,
    data: JsonObject,
    options?: ArmadilloTrustedPatchWhereOptions,
  ): Promise<{ changed: number }>;
  delete(table: string, id: string): Promise<void>;
  /**
   * Commit every step in one batch. A failure rolls the batch back.
   * patchWhere steps carry the same empty-where guard as the standalone call:
   * an empty `where` needs `options.all: true`, and unfiltered patches run in
   * bounded pages.
   */
  batch(steps: readonly ArmadilloTrustedBatchStep[]): Promise<void>;
  /**
   * Move one row into another table through an explicit transformation.
   * The handler authorizes the move; this helper keeps it safe: the target
   * audience must be within the source audience (a private row cannot move
   * into a public table), the owner and team stay server-owned, the
   * transformed data validates against the target schema, and a source edit
   * during the transform fails with 409 instead of moving stale data.
   * The insert and the source delete commit atomically.
   */
  promote(
    sourceTable: string,
    sourceId: string,
    targetTable: string,
    transform: (record: ArmadilloRecord) => JsonObject | Promise<JsonObject>,
  ): Promise<ArmadilloRecord>;
}

export interface ArmadilloTrustedGroup {
  id: string;
  slug: string;
  trusted: boolean;
  createdBy: string;
}

export interface ArmadilloTrustedGroups {
  get(groupId: string): Promise<ArmadilloTrustedGroup | null>;
  membership(groupId: string, userId: string): Promise<{ role: string } | null>;
  /**
   * Add an existing user. An existing membership keeps its role.
   * The owner role cannot be granted here.
   */
  addMember(groupId: string, userId: string, role: string): Promise<{ role: string }>;
}

export interface ArmadilloTrustedFile {
  name: string;
  contentType: string;
  size: number;
  ownerId: string;
  bytes: Uint8Array;
}

export interface ArmadilloTrustedAccess {
  /** Raw SQL escape hatch. Canonical apps use `records` instead. */
  db: ArmadilloDatabase;
  files: ArmadilloFileStorage;
  users: ArmadilloUserAdministration;
  records: ArmadilloTrustedRecords;
  groups: ArmadilloTrustedGroups;
  readFile(id: string, options?: { maxBytes?: number }): Promise<ArmadilloTrustedFile>;
}

export interface ArmadilloFunctionContext<TEnvironment extends object = {}, TInput extends object = JsonObject> {
  appId: string;
  /** Deployment stage supplied by the adapter. `local` is local development. */
  stage: string;
  functionName: string;
  /** Validated function input, exposed to middleware as read-only data. */
  data: Readonly<TInput>;
  /** The credential that invoked the function. `user` remains its data owner. */
  principal: ArmadilloRequestPrincipal;
  user: ArmadilloPrincipal;
  groups: ArmadilloGroupMembership[];
  request: Request;
  /** Typed capabilities contributed by the extensions registered for this app. */
  env: Readonly<TEnvironment>;
  records: ArmadilloRecordAccess;
  /** File IDs, with caller access and current link permissions checked each time. */
  files: ArmadilloCallerFiles;
  /** Requires authority: "trusted". `records` validates the schema and skips caller write policy. `db` is raw SQL; set group_id to the team field when inserting a JSON team row. */
  trusted: ArmadilloTrustedAccess;
  /** @deprecated Use trusted.db; requires authority: "trusted". */
  db: ArmadilloDatabase;
  /** @deprecated Use trusted.users; requires authority: "trusted". */
  users: ArmadilloUserAdministration;
  emit(type: string, data: JsonObject, groupId: string): Promise<void>;
  /** A request-scoped structured logger with Dillo context attached. */
  logger: ArmadilloLogger;
  /** Compatibility shorthand for an info-level structured event. */
  log(message: string, details?: JsonObject): void;
  /** Trace context of the enclosing `functions.handler` span. Attach these ids to join custom events to telemetry. */
  trace: { traceId: string; spanId: string };
  /**
   * Run work in a child diagnostic span. Failures mark the span and propagate
   * unchanged; like all telemetry, spans are only emitted when the backend
   * defines a telemetry sink. Never put secrets or user content in the name.
   */
  span<T>(name: string, run: () => Promise<T> | T, attributes?: Record<string, string | number | boolean>): Promise<T>;
}

/**
 * The portable shape implemented by Zod, Valibot, ArkType, and other Standard
 * Schema libraries. Dillo deliberately owns this tiny type instead of
 * depending on one validation package.
 */
export interface ArmadilloStandardSchema<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): ArmadilloStandardSchemaResult<TOutput> | Promise<ArmadilloStandardSchemaResult<TOutput>>;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

/** Infer successful validator output without relying on optional phantom fields. */
export type ArmadilloStandardSchemaOutput<T extends ArmadilloStandardSchema<unknown, unknown>> =
  Extract<Awaited<ReturnType<T["~standard"]["validate"]>>, { readonly value: unknown }>["value"];

export type ArmadilloStandardSchemaResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: readonly ArmadilloStandardSchemaIssue[] };

export interface ArmadilloStandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

/** A small escape hatch for a project-local validator without adopting a library. */
export interface ArmadilloFunctionParser<TOutput> {
  parse(value: unknown): TOutput | Promise<TOutput>;
}

export type ArmadilloFunctionValidator<TOutput> =
  | ArmadilloStandardSchema<unknown, TOutput>
  | ArmadilloFunctionParser<TOutput>;

export type ArmadilloFunctionContract<TOutput> =
  | { readonly kind: "fields"; readonly fields: FieldMap }
  | { readonly kind: "validator"; readonly validator: ArmadilloFunctionValidator<TOutput> };

export interface ArmadilloFunctionDefinition<
  TEnvironment extends object = {},
  TInput extends object = JsonObject,
  TOutput = JsonValue | undefined,
> {
  /** Discovery visibility never changes authorization. */
  description?: FunctionDescription;
  authorize?: {
    group: string;
    roles?: readonly string[];
  };
  /**
   * Explicitly declare that ANY authenticated caller may invoke this trusted
   * function, with the handler as the sole authorization layer. Only for
   * caller sets no group rule can express: pre-membership invite redeem,
   * owner-scoped personal products, and dynamic per-instance groups. NEVER
   * anonymous: authentication still runs before any authorization check
   * (see `executeFunction` in src/engine/functions.ts). NEVER a substitute
   * for a group you could have honestly named. Mutually exclusive with
   * .authorize(): declaring both throws at defineBackend.
   */
  public?: true;
  /** Buffer portable database writes and commit them as one atomic batch. */
  /** Require a native database transaction; unsupported adapters reject before running the handler.
   * Only context.db operations participate. Files, emitted events, and external effects do not. */
  transaction?: boolean;
  /** Explicitly grant this application function raw SQL, storage, and administration. */
  authority?: "trusted";
  middleware?: readonly Middleware[];
  /** Runtime contract for JSON request data. Prefer defineFunction() to declare one. */
  input?: ArmadilloFunctionContract<TInput>;
  /** Runtime contract for the JSON response returned to the caller. */
  output?: ArmadilloFunctionContract<TOutput>;
  handler(
    context: ArmadilloFunctionContext<TEnvironment, TInput>,
    data: TInput,
  ): Promise<TOutput> | TOutput;
}

function isFunctionValidator(value: unknown): value is ArmadilloFunctionValidator<unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return "~standard" in candidate || typeof candidate.parse === "function";
}

function functionContract<TOutput>(
  value: FieldMap | ArmadilloFunctionValidator<TOutput>,
): ArmadilloFunctionContract<TOutput> {
  return isFunctionValidator(value)
    ? { kind: "validator", validator: value as ArmadilloFunctionValidator<TOutput> }
    : { kind: "fields", fields: value };
}

function functionValidationError(
  direction: "input" | "output",
  fields: Record<string, string>,
): ArmadilloFunctionError {
  return direction === "input"
    ? new ArmadilloFunctionError(422, "VALIDATION_ERROR", "Function input is invalid.", fields)
    : new ArmadilloFunctionError(500, "INTERNAL_ERROR", "Function output does not match its contract.", fields);
}

async function validateFunctionContract<TOutput>(
  contract: ArmadilloFunctionContract<TOutput> | undefined,
  value: unknown,
  direction: "input" | "output",
): Promise<TOutput> {
  if (!contract) return value as TOutput;
  if (contract.kind === "fields") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw functionValidationError(direction, { data: "Expected an object" });
    }
    try {
      return validateFieldMapData(contract.fields, value as Record<string, unknown>, false) as TOutput;
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
          issue.message,
        ]));
        throw functionValidationError(direction, fields);
      }
      return result.value as TOutput;
    }
    return await validator.parse(value);
  } catch (error) {
    if (error instanceof ArmadilloFunctionError) throw error;
    const message = error instanceof Error ? error.message : "Validation failed";
    throw functionValidationError(direction, { data: message });
  }
}

/** Validate and optionally transform a function request before middleware runs. */
export function validateFunctionInput<TInput extends object>(
  definition: ArmadilloFunctionDefinition<object, TInput>,
  data: JsonObject,
): Promise<TInput> {
  return validateFunctionContract(definition.input, data, "input");
}

/** Validate and optionally transform a function response before it reaches the client. */
export async function validateFunctionOutput<TOutput>(
  definition: ArmadilloFunctionDefinition<object, object, TOutput>,
  value: TOutput,
): Promise<TOutput> {
  const output = await validateFunctionContract(definition.output, value, "output");
  if (output === undefined) return output;
  try {
    JSON.stringify(output);
  } catch {
    throw functionValidationError("output", { data: "Expected a JSON-serializable value" });
  }
  return output;
}

/**
 * Build a function with a typed, runtime-validated input and output contract.
 *
 * Dillo fields work with no dependency. Any Standard Schema implementation
 * (including Zod, Valibot, and ArkType) works through its native protocol.
 */
export class ArmadilloFunctionBuilder<
  TInput extends object = JsonObject,
  TOutput = JsonValue | undefined,
  TEnvironment extends object = {},
  TExplicitOutput extends boolean = false,
> {
  constructor(
    private readonly inputContract: ArmadilloFunctionContract<TInput> | undefined = undefined,
    private readonly outputContract: ArmadilloFunctionContract<TOutput> | undefined = undefined,
    private readonly description: FunctionDescription | undefined = undefined,
    private readonly authorizeRule: { group: string; roles?: readonly string[] } | undefined = undefined,
    private readonly middlewareList: readonly Middleware[] = [],
    private readonly useTransaction: boolean = false,
    private readonly authorityLevel: "trusted" | undefined = undefined,
    private readonly publicAccess: boolean = false,
  ) {}

  /** Require caller membership before the handler runs. Members without a listed role get 403. */
  authorize(auth: { group: string; roles?: readonly string[] }): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      auth,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess,
    );
  }

  /** Run middleware around the handler, after authorization. Calls append in order. */
  middleware(...handlers: Middleware[]): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      [...this.middlewareList, ...handlers],
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess,
    );
  }

  /** Run the handler inside a provider-native transaction. Adapters without one reject before running. */
  transaction(): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      true,
      this.authorityLevel,
      this.publicAccess,
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
  trusted(): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      "trusted",
      this.publicAccess,
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
  public(): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      true,
    );
  }

  input<const TFields extends FieldMap>(fields: TFields): ArmadilloFunctionBuilder<FieldMapInput<TFields>, TOutput, TEnvironment, TExplicitOutput>;
  input<TValidator extends ArmadilloStandardSchema<unknown, object>>(validator: TValidator): ArmadilloFunctionBuilder<ArmadilloStandardSchemaOutput<TValidator>, TOutput, TEnvironment, TExplicitOutput>;
  input<TNextInput extends object>(validator: ArmadilloFunctionParser<TNextInput>): ArmadilloFunctionBuilder<TNextInput, TOutput, TEnvironment, TExplicitOutput>;
  input<TNextInput extends object>(
    contract: FieldMap | ArmadilloFunctionValidator<TNextInput>,
  ): ArmadilloFunctionBuilder<TNextInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      functionContract(contract),
      this.outputContract,
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess,
    );
  }

  output<const TFields extends FieldMap>(fields: TFields): ArmadilloFunctionBuilder<TInput, FieldMapInput<TFields>, TEnvironment, true>;
  output<TValidator extends ArmadilloStandardSchema<unknown, unknown>>(validator: TValidator): ArmadilloFunctionBuilder<TInput, ArmadilloStandardSchemaOutput<TValidator>, TEnvironment, true>;
  output<TNextOutput>(validator: ArmadilloFunctionParser<TNextOutput>): ArmadilloFunctionBuilder<TInput, TNextOutput, TEnvironment, true>;
  output<TNextOutput>(
    contract: FieldMap | ArmadilloFunctionValidator<TNextOutput>,
  ): ArmadilloFunctionBuilder<TInput, TNextOutput, TEnvironment, true> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      functionContract(contract),
      this.description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess,
    );
  }

  describe(description: string | FunctionDescription): ArmadilloFunctionBuilder<TInput, TOutput, TEnvironment, TExplicitOutput> {
    return new ArmadilloFunctionBuilder(
      this.inputContract,
      this.outputContract,
      typeof description === "string" ? { summary: description } : description,
      this.authorizeRule,
      this.middlewareList,
      this.useTransaction,
      this.authorityLevel,
      this.publicAccess,
    );
  }

  handler<TActualOutput extends TOutput>(
    handler: (
      context: ArmadilloFunctionContext<TEnvironment, TInput>,
      data: TInput,
    ) => Promise<TActualOutput> | TActualOutput,
  ): ArmadilloFunctionDefinition<TEnvironment, TInput, TExplicitOutput extends true ? TOutput : TActualOutput> {
    return {
      ...(this.description ? { description: this.description } : {}),
      ...(this.authorizeRule ? { authorize: this.authorizeRule } : {}),
      ...(this.publicAccess ? { public: true } : {}),
      ...(this.middlewareList.length > 0 ? { middleware: this.middlewareList } : {}),
      ...(this.useTransaction ? { transaction: true } : {}),
      ...(this.authorityLevel ? { authority: this.authorityLevel } : {}),
      ...(this.inputContract ? { input: this.inputContract } : {}),
      ...(this.outputContract ? { output: this.outputContract as ArmadilloFunctionContract<TExplicitOutput extends true ? TOutput : TActualOutput> } : {}),
      handler: handler as ArmadilloFunctionDefinition<TEnvironment, TInput, TExplicitOutput extends true ? TOutput : TActualOutput>["handler"],
    };
  }
}

/** Start a typed function contract. This adds no runtime dependency. Hand-write the definition instead when the handler reads typed env secrets, which defineBackend infers from the backend. */
export function defineFunction<TEnvironment extends object = {}>(): ArmadilloFunctionBuilder<JsonObject, JsonValue | undefined, TEnvironment> {
  return new ArmadilloFunctionBuilder<JsonObject, JsonValue | undefined, TEnvironment>();
}

export interface ArmadilloRequestContext {
  request: Request;
  /** Adapter-resolved application identity for provider-neutral listeners. */
  appId: string;
}

export type ArmadilloAppAuth = "required" | "optional" | "none";
export type ArmadilloAppMode = "managed" | "external" | "public";
export type ArmadilloCapabilities = Readonly<Record<string, readonly string[]>>;

/** A declaration of a runtime value owned by the deployment platform. */
export interface ArmadilloSecret<TName extends string = string, TRequired extends boolean = boolean> {
  readonly __armadilloSecret: true;
  /** Explicit names are useful outside an object declaration. */
  readonly name?: TName;
  description?: string;
  required?: TRequired;
}

export type ArmadilloSecretMap = Readonly<Record<string, ArmadilloSecret>>;

export type SecretEnvironment<TSecrets extends ArmadilloSecretMap | undefined> =
  TSecrets extends ArmadilloSecretMap ? {
    readonly [TKey in keyof TSecrets]: TSecrets[TKey] extends ArmadilloSecret<string, false> ? string | undefined : string;
  } : {};

/**
 * Declare an application secret requirement without storing its value. When
 * used as `{ STRIPE_SECRET_KEY: secret() }`, the object key is its name.
 */
export function secret<const TName extends string, const TRequired extends boolean = true>(
  name?: TName,
  options: { description?: string; required?: TRequired } = {},
): ArmadilloSecret<TName, TRequired> {
  return Object.freeze({
    __armadilloSecret: true as const,
    ...(name ? { name } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.required === undefined ? {} : { required: options.required }),
  });
}

export interface ArmadilloSecretRequirement {
  name: string;
  description?: string;
  required: boolean;
}

/**
 * A public client identity and its maximum authority. `id` and `clientKey` are
 * deliberately publishable identifiers; credentials and record policy remain
 * separate server-side checks.
 */
export interface ArmadilloRegisteredApp {
  id: string;
  name: string;
  mode?: ArmadilloAppMode;
  auth?: ArmadilloAppAuth;
  origins?: readonly string[];
  capabilities?: ArmadilloCapabilities;
  /** Explicitly public, client-safe configuration for this registered app. */
  public?: Readonly<JsonObject>;
  enabled?: boolean;
  clientKey?: string;
  provenance?: {
    version?: string;
    bundleHash?: string;
    deploymentId?: string;
  };
}

export interface ArmadilloCollectorDefinition<TFields extends FieldMap = FieldMap> {
  fields: TFields;
  /** Optional application model that receives a normal Dillo record for each submission. */
  model?: string;
  /** Whether a submission must, may, or must not carry a user credential. */
  auth?: ArmadilloAppAuth;
  /** Stop accepting submissions after this ISO timestamp. */
  expiresAt?: string;
  /** Automatically purge submissions after this many days. Defaults to 365. */
  retentionDays?: number;
  /** Optional project label copied onto every submission. */
  project?: string;
  /** Team slug and roles allowed to read captured data. */
  access: {
    team: string;
    roles?: readonly string[];
  };
}

export interface ArmadilloTicketPolicy {
  /** Team slug whose members may work with tickets. */
  team: string;
  readRoles?: readonly string[];
  issueRoles?: readonly string[];
  consumeRoles?: readonly string[];
}

/** Validate and retain a typed, canonical app registration in backend.ts. */
export function app<const TApp extends ArmadilloRegisteredApp>(definition: TApp): TApp {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(definition.id)) {
    throw new TypeError("Registered app ids must start with a letter and use letters, numbers, _ or -.");
  }
  if (!definition.name.trim() || definition.name.length > 120) {
    throw new TypeError("Registered app names must use 1 to 120 characters.");
  }
  for (const [resource, actions] of Object.entries(definition.capabilities ?? {})) {
    if (!/^(?:\*|[A-Za-z][A-Za-z0-9_-]{0,62}(?::[A-Za-z][A-Za-z0-9_-]{0,62})?)$/.test(resource)
      || actions.length === 0
      || actions.some((action) => !/^(?:\*|[A-Za-z][A-Za-z0-9:_-]{0,95})$/.test(action))) {
      throw new TypeError(`Registered app capability \`${resource}\` is invalid.`);
    }
  }
  for (const origin of definition.origins ?? []) {
    if (origin === "self" || origin === "http://localhost:*" || origin === "http://127.0.0.1:*") continue;
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) throw new Error();
    } catch {
      throw new TypeError(`Registered app origin \`${origin}\` must be an exact HTTP origin.`);
    }
  }
  return definition;
}

/** Collect declared application and extension secrets without their values. */
export function requiredSecrets(
  definition: Pick<ArmadilloBackendDefinition, "secrets" | "extensions" | "webhooks">,
): ArmadilloSecretRequirement[] {
  const requirements = new Map<string, ArmadilloSecretRequirement>();
  const add = (requirement: ArmadilloSecretRequirement) => {
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
      ...(value.description ? { description: value.description } : {}),
      required: value.required !== false,
    });
  }
  for (const extension of definition.extensions ?? []) {
    for (const requirement of extension.requirements?.secrets ?? []) {
      add({
        name: requirement.name,
        ...(requirement.description ? { description: requirement.description } : {}),
        required: requirement.required !== false,
      });
    }
  }
  for (const webhook of Object.values(definition.webhooks ?? {})) {
    if (typeof webhook.secret !== "string") {
      const value = webhook.secret;
      if (!value.name) throw new TypeError("Webhook secrets need an explicit name.");
      add({ name: value.name, required: true, ...(value.description ? { description: value.description } : {}) });
    }
  }
  return [...requirements.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Define a validated form/capture boundary without creating a general table API. */
export function collector<const TCollector extends ArmadilloCollectorDefinition>(
  definition: TCollector,
): TCollector {
  if (Object.keys(definition.fields).length === 0) throw new TypeError("Collectors need at least one field.");
  if (Object.values(definition.fields).some((field) => field.config.type === "file")) {
    throw new TypeError("Collector file fields are not supported yet; upload through the authenticated Files API.");
  }
  if (definition.retentionDays !== undefined
    && (!Number.isSafeInteger(definition.retentionDays)
      || definition.retentionDays < 1
      || definition.retentionDays > 3_650)) {
    throw new TypeError("Collector retentionDays must be an integer from 1 to 3,650.");
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(definition.access.team)) {
    throw new TypeError("Collector access.team must be a valid team slug.");
  }
  if (definition.model !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.model)) {
    throw new TypeError("Collector model must start with a letter and use letters, numbers, _ or -.");
  }
  if (definition.access.roles?.length === 0
    || definition.access.roles?.some((role) => !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) {
    throw new TypeError("Collector access.roles must contain valid team roles.");
  }
  if (definition.expiresAt !== undefined && !Number.isFinite(Date.parse(definition.expiresAt))) {
    throw new TypeError("Collector expiresAt must be an ISO-compatible timestamp.");
  }
  return definition;
}

export type ArmadilloRequestListener = (
  context: ArmadilloRequestContext,
) => Response | undefined | Promise<Response | undefined>;

type UnionToIntersection<T> =
  (T extends unknown ? (value: T) => void : never) extends (value: infer TResult) => void
    ? TResult
    : never;
type Simplify<T> = { [TKey in keyof T]: T[TKey] } & {};
export type ExtensionEnvironment<TExtensions extends readonly ArmadilloExtension[]> = Simplify<
  UnionToIntersection<ExtensionEnvironmentOf<TExtensions[number]>>
>;

export interface ArmadilloBackendDefinition<TEnvironment extends object = {}> {
  /** File storage is enabled for compatibility; false omits the owned file resource. */
  files?: boolean;
  schema?: SchemaDefinition;
  /**
   * Optional external identity verifier. Dillo keeps authorization and
   * data ownership, while this provider owns sign-in and sessions.
   */
  auth?: ArmadilloAuthProvider;
  /** Optional structured event sink. Dillo never sends telemetry unless you provide one. */
  logger?: ArmadilloLogger;
  /** Optional diagnostic spans; not durable audit records. */
  telemetry?: ArmadilloTelemetry;
  /** Optional packages such as the data browser and user settings. */
  extensions?: readonly ArmadilloExtension[];
  /** Cross-cutting function middleware. Extensions run first, then application middleware. */
  middleware?: readonly Middleware[];
  realtime?: RealtimeConfig;
  webhooks?: Record<string, WebhookDefinition>;
  /**
   * Optional usage metering quotas (Slice 1). Daily UTC ceilings enforced at
   * the same layer as rate limits. Metering records rollups even when quotas
   * are omitted. See docs/tasks/usage-metering-quotas.md.
   */
  usage?: import("./usage-config.js").UsageConfig;
  /**
   * User-defined schedules (Slice 1). Cron + principal; dispatched by the
   * maintenance sweep. See docs/tasks/scheduled-functions-jobs.md.
   */
  schedules?: Record<string, ScheduleDefinition>;
  /** Optional registered-app metadata and policy. Omit for normal public clients. */
  apps?: Record<string, ArmadilloRegisteredApp>;
  /** Raw deployment/runtime secrets needed by application functions. */
  secrets?: ArmadilloSecretMap;
  /** Typed, expiring data-capture endpoints. */
  collectors?: Record<string, ArmadilloCollectorDefinition>;
  /** Optional team/role policy applied to the first-class ticket endpoints. */
  tickets?: ArmadilloTicketPolicy;
  /** GDPR: export / erasure / consent / retention. Absent = defaults + per-user rights. */
  gdpr?: ArmadilloGdprConfig;
  /** Explicitly installed browser microapps. No UI is mounted by default. */
  ui?: ArmadilloUi;
  /**
   * Structure discovery for LLMs / micro-app codegen.
   * Default ON. Set `false` or `{ structure: false }` to hide
   * `GET /v1/schema` and `GET /v1/discovery*` (404 STRUCTURE_DISCOVERY_DISABLED).
   * Build-time `promptPack()` / `mcp()` still work.
   */
  discovery?: ArmadilloDiscoveryConfig;
  functions?: Record<string, ArmadilloFunctionDefinition<TEnvironment>>;
  listeners?: {
    /** Runs before Dillo's API router; return undefined to continue. */
    request?: ArmadilloRequestListener;
  };
}

/**
 * Define a Dillo application independently of its hosting provider.
 * Adapters consume the returned data without adding runtime wrappers or state.
 */
type KnownFunctions<T> = { [K in keyof T as string extends K ? never : K]: T[K] };

type ExtensionFunctions<TExtensions extends readonly ArmadilloExtension[]> =
  UnionToIntersection<TExtensions[number] extends infer TExtension
    ? TExtension extends { functions: infer TFunctions } ? KnownFunctions<TFunctions> : {}
    : {}>;

export type DiscoveredBackend<TBackend> = TBackend & {
  /** HTTP API discovery metadata; this does not start an MCP protocol server. */
  mcp(): ArmadilloDiscovery;
  /** Copyable per-app prompt pack (tables, functions, REST, Markdown). Always available at build time. */
  promptPack(options?: { baseUrl?: string }): ArmadilloPromptPack;
};

/**
 * Fail-closed registration gate: a trusted function must declare its caller
 * model, or registration refuses it outright. The declaration is either
 * .authorize({ group: "<slug>" }) — callers restricted to a trusted group —
 * or .public() — any authenticated caller may invoke, with the handler as
 * the sole authorization layer. What the gate stops is *undeclared*
 * authorization, not broad authorization: it cannot stop an author from
 * naming a junk group, which is why .public() exists as an explicit,
 * greppable declaration instead. The silent case (neither) throws; declaring
 * both caller models on one function throws. The handler's own checks remain
 * a second layer under .authorize(), and the only layer under .public().
 * .public() is never anonymous: requireAuth runs before the authorize check
 * in src/engine/functions.ts.
 */
function assertTrustedAuthorized(functions: Record<string, ArmadilloFunctionDefinition>): void {
  for (const [name, fn] of Object.entries(functions)) {
    if (fn.authorize && fn.public) {
      throw new TypeError(
        `Dillo security: function "${name}" declares both .authorize() and .public(): `
        + `a function has one caller model — a named group, or any authenticated caller with the handler as the sole authorization layer. Choose one.`,
      );
    }
    if (fn.authority === "trusted" && !fn.authorize && !fn.public) {
      throw new TypeError(
        `Dillo security: function "${name}" registers authority: "trusted" without an authorize() rule or a .public() declaration, `
        + `so any holder of the functions:${name} API scope could invoke it with raw capabilities. `
        + `Add .authorize({ group: "<slug>" }) to restrict callers to a trusted group, `
        + `or .public() to declare any authenticated caller may invoke, with the handler as the sole authorization layer.`,
      );
    }
  }
}

export function defineBackend<
  // `any` here is a *constraint* position, not a value type: it keeps each
  // extension's own environment type free to be inferred from the tuple. Pinning
  // it to the `{}` default collapses `ExtensionEnvironment<TExtensions>` and
  // strips every contributed `env.*` member from the function signatures.
  const TExtensions extends readonly ArmadilloExtension<any>[] = [],
  const TSecrets extends ArmadilloSecretMap = {},
  const TSchema extends SchemaDefinition | undefined = undefined,
  const TFunctions extends Record<string, ArmadilloFunctionDefinition<ExtensionEnvironment<TExtensions> & SecretEnvironment<TSecrets>>> = {},
>(
  definition: Omit<ArmadilloBackendDefinition<ExtensionEnvironment<TExtensions> & SecretEnvironment<TSecrets>>, "extensions" | "secrets" | "schema" | "functions"> & {
    extensions?: TExtensions;
    secrets?: TSecrets;
    schema?: TSchema;
    functions?: TFunctions & Record<string, ArmadilloFunctionDefinition<ExtensionEnvironment<TExtensions> & SecretEnvironment<TSecrets>, any, any>>;
  },
): DiscoveredBackend<Omit<ArmadilloBackendDefinition<ExtensionEnvironment<TExtensions> & SecretEnvironment<TSecrets>>, "schema" | "functions"> & {
  functions: KnownFunctions<TFunctions> & ExtensionFunctions<TExtensions>;
} & (TSchema extends SchemaDefinition ? { schema: TSchema } : {})>;
export function defineBackend(definition: ArmadilloBackendDefinition): ArmadilloBackendDefinition {
  validateWebhookDefinitions(definition.webhooks);
  validateUsageConfig(definition.usage);
  validateScheduleDefinitions(
    definition.schedules,
    new Set(Object.keys(definition.functions ?? {})),
  );
  validateGdprConfig(definition.gdpr);
  validateUi(definition.ui);
  if (definition.files === false && Object.values(definition.ui?.apps ?? {}).some(app => app.requires?.includes("files"))) {
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
      promptPack: (options?: { baseUrl?: string }) => buildPromptPack(discovered, options),
    });
  })();

  const extensions = definition.extensions;
  const names = new Set<string>();
  for (const extension of extensions) {
    if (names.has(extension.name)) throw new TypeError(`Duplicate extension: \`${extension.name}\`.`);
    names.add(extension.name);
  }
  const merge = <TValue>(label: string, entries: readonly (Record<string, TValue> | undefined)[]) => {
    const output: Record<string, TValue> = Object.create(null);
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
    [...extensions.map((extension) => extension.functions), definition.functions],
  ) as Record<string, ArmadilloFunctionDefinition>;
  assertTrustedAuthorized(functions);
  const extensionListeners = definition.extensions
    .map((extension) => extension.listener)
    .filter((listener): listener is ArmadilloRequestListener => listener !== undefined);
  const applicationListener = definition.listeners?.request;
  const middleware = [
    ...extensions.flatMap((extension) => extension.middleware ?? []),
    ...(definition.middleware ?? []),
  ];

  return (() => {
    const discovered = withDiscovery({
    ...definition,
    functions,
    apps: merge("app", [...extensions.map((extension) => extension.apps), definition.apps]),
    collectors: merge(
      "collector",
      [...extensions.map((extension) => extension.collectors), definition.collectors],
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
      },
    },
  });
    return Object.assign(discovered, {
      promptPack: (options?: { baseUrl?: string }) => buildPromptPack(discovered, options),
    });
  })();
}

export { auditLog, composeMiddleware, rateLimit, retry, validateInput } from "./middleware.js";
export { defineExtension } from "./extensions.js";
export type {
  ArmadilloExtension,
  ArmadilloExtensionEnvironment,
  ArmadilloExtensionRequirements,
  ArmadilloExtensionRuntimeContext,
} from "./extensions.js";
export type { Middleware, RetryOptions } from "./middleware.js";
export type { RealtimeConfig } from "./realtime.js";
export type { WebhookDefinition, WebhookEvent } from "./webhooks.js";

// The names and sanitized admin resources are Dillo semantics. Physical
// migration/execution remains the responsibility of each database adapter.
export * from "./internal-schema.js";
export type { UsageConfig, UsageQuotas } from "./usage-config.js";
export type {
  ScheduleDefinition,
  SchedulePrincipal,
  ScheduleRetryOptions,
} from "./schedules.js";
