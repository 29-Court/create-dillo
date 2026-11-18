import {
  compilePermissions,
  explainSchema,
  type PermissionPolicy,
} from "./access.js";

export type {
  AccessTerm,
  PermissionPolicy,
} from "./access.js";
export {
  anyone,
  explainSchema,
  members,
  nobody,
  owner,
  recordOwner,
  roles,
} from "./access.js";

export type SchemaFieldType =
  | "string"
  | "number"
  | "integer"
  | "json"
  | "boolean"
  | "email"
  | "pointer"
  | "file"
  | "computed"
  | "geo"
  | "tickets";

export interface NormalizedField {
  type: SchemaFieldType;
  required: boolean;
  format?: "date" | "date-time";
  nullable?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  /** Target table for pointer fields. `_User` and `_Team` are system targets. */
  target?: string;
  /** Accepted MIME patterns for file fields, for example `application/pdf` or `image/*`. */
  contentTypes?: string[];
  /** Maximum uploaded file size in bytes. */
  maxBytes?: number;
  /** Result type for a virtual computed field. Computeds are never persisted. */
  computedType?: "string" | "integer" | "boolean";
  /** Optional generated spatial index name for geo fields. */
  geoIndex?: string;
  minAltitude?: number;
  maxAltitude?: number;
  /** Set by `unique()` on text, email, and integer. User profile fields keep this flag. */
  unique?: boolean;
  /** Initial supply for a tickets field. Absent means unset, not unlimited. */
  supply?: number;
}

export interface NormalizedIndex {
  fields: string[];
  unique: boolean;
}

export interface NormalizedTeamAccess {
  field: string;
  readRoles?: string[];
  writeRoles?: string[];
  /** Members may create records and write their own, in addition to writeRoles. */
  ownerWrite?: boolean;
  /** Record-API writes are closed. A trusted function can still change rows through `context.trusted.records`. */
  writes?: "none";
}

export interface NormalizedTable {
  fields: Record<string, NormalizedField>;
  /** Read-only fields evaluated by application code after a record is loaded. */
  computeds?: Record<string, { type: "string" | "integer" | "boolean" }>;
  read: "owner" | "public";
  /** JSON is the zero-ceremony default; columns materializes declared fields. */
  storage: "json" | "columns";
  indexes: Record<string, NormalizedIndex>;
  team?: NormalizedTeamAccess;
  /** Record-API writes are closed for every caller, including the owner. */
  writes?: "none";
}

export interface NormalizedUserProfile {
  fields: Record<string, NormalizedField>;
}

export interface NormalizedSchema {
  tables: Record<string, NormalizedTable>;
  /** Profile fields from `users.extend`, stored as JSON on `_armadillo_users`. */
  users?: NormalizedUserProfile;
}

export class FieldDefinition<
  TValue,
  TRequired extends boolean = true,
  THasDefault extends boolean = false,
> {
  /** @internal Type-only marker used for schema inference. */
  declare readonly __types: {
    value: TValue;
    required: TRequired;
    hasDefault: THasDefault;
  };

  /** @internal */
  readonly config: NormalizedField;

  /** @internal */
  constructor(config: NormalizedField) {
    this.config = config;
  }

  /** Accept null explicitly, for example when clearing a pointer. */
  nullable(): FieldDefinition<TValue | null, TRequired, THasDefault> {
    return new FieldDefinition({ ...this.config, nullable: true });
  }

  /** Require a calendar date, `YYYY-MM-DD`. */
  date(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault> {
    if (this.config.type !== "string") throw new TypeError("date() requires a string field.");
    if (this.config.format === "date-time") throw new TypeError("date() cannot be combined with datetime().");
    return new FieldDefinition({ ...this.config, format: "date" });
  }

  /** Require an RFC 3339 timestamp with an explicit UTC offset. */
  datetime(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault> {
    if (this.config.type !== "string") throw new TypeError("datetime() requires a string field.");
    if (this.config.format === "date") throw new TypeError("datetime() cannot be combined with date().");
    return new FieldDefinition({ ...this.config, format: "date-time" });
  }

  /** Validate the string as an email address. */
  email(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault> {
    if (this.config.type !== "string" && this.config.type !== "email") {
      throw new TypeError("email() requires a string field.");
    }
    if (this.config.format) throw new TypeError("email() cannot be combined with date() or datetime().");
    return new FieldDefinition({ ...this.config, type: "email" });
  }

  optional(): FieldDefinition<TValue, false, THasDefault> {
    return new FieldDefinition({ ...this.config, required: false });
  }

  default(value: TValue): FieldDefinition<TValue, TRequired, true> {
    return new FieldDefinition({ ...this.config, default: value });
  }

  /** One value per row. Legal on text, email, and integer. */
  unique(): FieldDefinition<TValue, TRequired, THasDefault> {
    if (this.config.type !== "string" && this.config.type !== "email" && this.config.type !== "integer") {
      throw new TypeError("unique() is only legal on text, email, and integer.");
    }
    return new FieldDefinition({ ...this.config, unique: true });
  }

  min(value: number): FieldDefinition<TValue, TRequired, THasDefault> {
    return new FieldDefinition({ ...this.config, min: value });
  }

  max(value: number): FieldDefinition<TValue, TRequired, THasDefault> {
    return new FieldDefinition({ ...this.config, max: value });
  }
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;
const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i;
const SIZE_UNITS = { b: 1, kb: 1_024, mb: 1_024 ** 2, gb: 1_024 ** 3 } as const;

function bytes(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("File size must be a positive byte count.");
    return value;
  }
  const match = SIZE.exec(value.trim());
  const unit = match?.[2]?.toLowerCase() as keyof typeof SIZE_UNITS | undefined;
  const amount = Number(match?.[1]);
  const result = unit ? Math.round(amount * SIZE_UNITS[unit]) : Number.NaN;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError("File size must look like `500 KB`, `10 MB`, or a positive byte count.");
  }
  return result;
}

export class FileFieldDefinition<TRequired extends boolean = true>
  extends FieldDefinition<string, TRequired, false> {
  override optional(): FileFieldDefinition<false> {
    return new FileFieldDefinition({ ...this.config, required: false });
  }

  /** Accept one or more exact MIME types or wildcard families such as `image/*`. */
  accept(...contentTypes: string[]): FileFieldDefinition<TRequired> {
    if (contentTypes.length === 0 || contentTypes.some((value) => !MIME.test(value))) {
      throw new TypeError("File content types must look like `application/pdf` or `image/*`.");
    }
    return new FileFieldDefinition({
      ...this.config,
      contentTypes: [...new Set(contentTypes.map((value) => value.toLowerCase()))].sort(),
    });
  }

  /** Memorable alias for `accept()`. */
  contentType(...contentTypes: string[]): FileFieldDefinition<TRequired> {
    return this.accept(...contentTypes);
  }

  /** Limit file size with bytes or a readable value such as `10 MB`. */
  maxSize(value: number | string): FileFieldDefinition<TRequired> {
    return new FileFieldDefinition({ ...this.config, maxBytes: bytes(value) });
  }
}

// `any` is intentional here: FieldMap is the heterogeneous schema boundary;
// each concrete value type is recovered from the individual field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyField = FieldDefinition<any, boolean, boolean>;
export type FieldMap = Record<string, AnyField>;

export interface TableDefinition<TFields extends FieldMap = FieldMap> {
  readonly fields: TFields;
  readonly read: "owner" | "public";
  readonly storage: "json" | "columns";
  readonly indexes: Record<string, NormalizedIndex>;
  readonly team?: NormalizedTeamAccess;
  readonly writes?: "none";
}

/** A table plus the access spelling. The spelling compiles to `read`, `writes`, and `team`. */
export interface DefinedTable<TFields extends FieldMap = FieldMap> extends TableDefinition<TFields> {
  permissions(policy: PermissionPolicy): DefinedTable<TFields>;
}

export interface SchemaDefinition<TTables extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
  readonly tables: TTables;
  readonly normalized: NormalizedSchema;
}

/** A schema built by `schema()`, including the printed access law. */
export interface ExplainedSchema<TTables extends Record<string, TableDefinition> = Record<string, TableDefinition>>
  extends SchemaDefinition<TTables> {
  explain(): string;
}

export function string(): FieldDefinition<string> {
  return new FieldDefinition({ type: "string", required: true });
}

export function text(): FieldDefinition<string> {
  return string();
}

export function email(): FieldDefinition<string> {
  return new FieldDefinition({ type: "email", required: true });
}

/** A finite number, including whole numbers. Use `integer()` when a fraction is meaningless. */
export function number(): FieldDefinition<number> {
  return new FieldDefinition({ type: "number", required: true });
}

export function integer(): FieldDefinition<number> {
  return new FieldDefinition({ type: "integer", required: true });
}

export type SchemaJsonValue =
  | string
  | number
  | boolean
  | null
  | SchemaJsonValue[]
  | { [key: string]: SchemaJsonValue };

/**
 * Structured data that stays with the record. Primitive values at bounded
 * object paths can be matched with Query.whereJsonPath on SQLite and D1.
 */
export function json(): FieldDefinition<SchemaJsonValue> {
  return new FieldDefinition({ type: "json", required: true });
}

function jsonShape(value: unknown, seen?: WeakSet<object>): string | undefined {
  const visiting = seen ?? new WeakSet();
  if (value === undefined) return "JSON cannot contain undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "JSON numbers must be finite";
  if (typeof value !== "object") return "Expected a JSON value";
  if (visiting.has(value)) return "JSON cannot contain a cycle";
  visiting.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return "JSON cannot contain an empty array position";
      const issue = jsonShape(value[index], visiting);
      if (issue) {
        visiting.delete(value);
        return issue;
      }
    }
    visiting.delete(value);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    const issue = jsonShape((value as Record<string, unknown>)[key], visiting);
    if (issue) {
      visiting.delete(value);
      return issue;
    }
  }
  visiting.delete(value);
  return undefined;
}

/** A copy with sorted keys, so the same value has one stored form. */
export function stableJson(value: SchemaJsonValue): SchemaJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => stableJson(item));
  const result: { [key: string]: SchemaJsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) continue;
    // Assignment to "__proto__" replaces the prototype and drops the field.
    Object.defineProperty(result, key, {
      value: stableJson(descriptor.value as SchemaJsonValue),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export function boolean(): FieldDefinition<boolean> {
  return new FieldDefinition({ type: "boolean", required: true });
}

export function bool(): FieldDefinition<boolean> {
  return boolean();
}

export class PointerFieldDefinition<
  TTarget extends string,
  TRequired extends boolean = true,
  THasDefault extends boolean = false,
> extends FieldDefinition<string, TRequired, THasDefault> {
  /** @internal Type-only relation target used by the client query builder. */
  declare readonly __target: TTarget;

  override optional(): PointerFieldDefinition<TTarget, false, THasDefault> {
    return new PointerFieldDefinition({ ...this.config, required: false });
  }

  override default(value: string): PointerFieldDefinition<TTarget, TRequired, true> {
    return new PointerFieldDefinition({ ...this.config, default: value });
  }

  override min(value: number): PointerFieldDefinition<TTarget, TRequired, THasDefault> {
    return new PointerFieldDefinition({ ...this.config, min: value });
  }

  override max(value: number): PointerFieldDefinition<TTarget, TRequired, THasDefault> {
    return new PointerFieldDefinition({ ...this.config, max: value });
  }
}

/**
 * Store the id of another Armadillo record while retaining its target in schema
 * metadata. Pointers remain JSON strings on the wire and can be queried like
 * any other field; adapters may use `target` to add joins or integrity checks.
 *
 * @deprecated Use {@link relation} instead. This alias keeps working.
 */
export function pointer<const TTarget extends string>(
  target: TTarget,
): PointerFieldDefinition<TTarget> {
  return new PointerFieldDefinition({ type: "pointer", required: true, target });
}

/**
 * Point at a table key. `ref("users")` is an Armadillo user. `ref("files")` is an
 * uploaded file. `_User` and `_Team` stay valid targets.
 */
export function ref(target: "files"): FileFieldDefinition;
export function ref(target: "users"): PointerFieldDefinition<"_User">;
export function ref<const TTarget extends string>(target: TTarget): PointerFieldDefinition<TTarget>;
export function ref(target: string): FileFieldDefinition | PointerFieldDefinition<string> {
  if (target === "files") return file();
  if (target === "users") return relation.user();
  return pointer(target);
}

/** Store the id of another table's record. This is the canonical pointer spelling. */
export function relation<const TTarget extends string>(target: TTarget): PointerFieldDefinition<TTarget> {
  return pointer(target);
}

export namespace relation {
  /** A pointer at an Armadillo user. */
  export function user(): PointerFieldDefinition<"_User"> {
    return pointer("_User");
  }

  /** The one team pointer a table's permissions can prove. */
  export function team(): PointerFieldDefinition<"_Team"> {
    return pointer("_Team");
  }
}

/** Store an uploaded Armadillo file id with optional MIME and size constraints. */
export function file(): FileFieldDefinition {
  return new FileFieldDefinition({ type: "file", required: true });
}

/** What a reader sees for a tickets field. `sold` and the token stay off the record. */
export interface TicketRead {
  remaining: number | null;
}

/**
 * Inventory on one record. Omitted `supply` is unset, not unlimited.
 * The stored value is `{ supply, sold }`; readers see `{ remaining }`.
 */
export function tickets(options?: { supply?: number }): FieldDefinition<TicketRead, false, false> {
  const supply = options?.supply;
  if (supply !== undefined && (!Number.isSafeInteger(supply) || supply < 0)) {
    throw new TypeError("tickets supply must be a non-negative integer.");
  }
  return new FieldDefinition({
    type: "tickets",
    required: false,
    ...(supply !== undefined ? { supply } : {}),
  });
}

export interface TableOptions<TFields extends FieldMap> {
  read?: "owner" | "public";
  /**
   * Persist declared fields as real SQL columns. The default `json` mode keeps
   * Armadillo's schema-free, document-oriented workflow.
   */
  storage?: "json" | "columns";
  /** Named indexes created by the application migration for column-backed tables. */
  indexes?: Record<string, {
    fields: readonly (Extract<keyof TFields, string> | "id" | "ownerId" | "createdAt" | "updatedAt")[];
    unique?: boolean;
  }>;
  /**
   * Close creates, updates, and deletes for every caller, including the owner.
   * Reads still follow `read`. A trusted function changes rows through
   * `context.trusted.records`. Do not combine with team `writeRoles` or `ownerWrite`.
   */
  writes?: "none";
  /** Share records through an `_Team` pointer instead of owner-only access. */
  team?: {
    field: Extract<keyof TFields, string>;
    readRoles?: readonly string[];
    writeRoles?: readonly string[];
    /** Members may create records and write their own, in addition to writeRoles. */
    ownerWrite?: boolean;
    /**
     * Close creates, updates, and deletes for every member, including the owner.
     * Reads still follow `readRoles`. Caller-scoped `records` uses this same
     * rule. A function declared `authority: "trusted"` can change rows through
     * `context.trusted.records` after its own authorization check. Do not combine
     * with `writeRoles` or `ownerWrite`.
     */
    writes?: "none";
  };
}

export function table<const TFields extends FieldMap>(
  fields: TFields,
  options: TableOptions<TFields> = {},
): DefinedTable<TFields> {
  return defineTable(fields, options, "options");
}

function defineTable<const TFields extends FieldMap>(
  fields: TFields,
  options: TableOptions<TFields>,
  source: "options" | "permissions",
): DefinedTable<TFields> {
  const indexes: Record<string, NormalizedIndex> = {};
  for (const indexName of Object.keys(options.indexes ?? {}).sort()) {
    if (!FIELD.test(indexName)) throw new TypeError(`Schema index name \`${indexName}\` is invalid.`);
    const index = options.indexes?.[indexName];
    if (!index || index.fields.length === 0 || index.fields.length > 8) {
      throw new TypeError(`Schema index \`${indexName}\` needs between 1 and 8 fields.`);
    }
    const normalizedFields = [...index.fields];
    for (const fieldName of normalizedFields) {
      const system = ["id", "ownerId", "createdAt", "updatedAt"].includes(fieldName);
      if (!system && !Object.hasOwn(fields, fieldName)) {
        throw new TypeError(`Schema index \`${indexName}\` references unknown field \`${fieldName}\`.`);
      }
      if (!system && fields[fieldName]?.config.type === "computed") {
        throw new TypeError(`Schema index \`${indexName}\` cannot reference computed field \`${fieldName}\`.`);
      }
    }
    if (new Set(normalizedFields).size !== normalizedFields.length) {
      throw new TypeError(`Schema index \`${indexName}\` repeats a field.`);
    }
    indexes[indexName] = { fields: normalizedFields, unique: index.unique ?? false };
  }
  if ((options.storage ?? "json") === "json" && Object.keys(indexes).length > 0) {
    throw new TypeError("Declared indexes require `storage: \"columns\"`.");
  }
  if (options.writes !== undefined && options.writes !== "none") {
    throw new TypeError("Table writes must be \"none\" when set.");
  }
  if (options.writes === "none" && (options.team?.writeRoles !== undefined || options.team?.ownerWrite)) {
    throw new TypeError("writes: \"none\" cannot be combined with writeRoles or ownerWrite.");
  }
  if ((options.storage ?? "json") === "json"
    && Object.values(fields).some((field) => field.config.type === "geo" && field.config.geoIndex)) {
    throw new TypeError("Geo indexes require `storage: \"columns\"`.");
  }
  let team: NormalizedTeamAccess | undefined;
  if (options.team) {
    const field = fields[options.team.field];
    if (field?.config.type !== "pointer" || field.config.target !== "_Team") {
      throw new TypeError("Team access must reference a `relation.team()` or `ref(\"_Team\")` field.");
    }
    if ((options.read ?? "owner") === "public") {
      throw new TypeError("A public table cannot also use team-scoped access.");
    }
    const roles = (values: readonly string[] | undefined, label: string) => {
      if (values === undefined) return undefined;
      if (values.length === 0 || values.some((role) => !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) {
        throw new TypeError(`${label} must contain one or more valid team roles.`);
      }
      return [...new Set(values)].sort();
    };
    if (options.team.writes !== undefined && options.team.writes !== "none") {
      throw new TypeError("Team writes must be \"none\" when set.");
    }
    if (options.team.writes === "none" && (options.team.writeRoles !== undefined || options.team.ownerWrite)) {
      throw new TypeError("Team writes: \"none\" cannot be combined with writeRoles or ownerWrite.");
    }
    const readRoles = roles(options.team.readRoles, "readRoles");
    const writeRoles = roles(options.team.writeRoles, "writeRoles");
    team = {
      field: options.team.field,
      ...(readRoles ? { readRoles } : {}),
      ...(writeRoles ? { writeRoles } : {}),
      ...(options.team.ownerWrite ? { ownerWrite: true } : {}),
      ...(options.team.writes === "none" ? { writes: "none" as const } : {}),
    };
  }
  const defined: TableDefinition<TFields> = {
    fields,
    read: options.read ?? "owner",
    storage: options.storage ?? "json",
    indexes,
    ...(team ? { team } : {}),
    ...(options.writes === "none" ? { writes: "none" as const } : {}),
  };
  const withPermissions = defined as DefinedTable<TFields>;
  Object.defineProperty(withPermissions, "permissions", {
    enumerable: false,
    value: (policy: PermissionPolicy): DefinedTable<TFields> => {
      if (
        source === "options"
        && (options.read !== undefined || options.writes !== undefined || options.team !== undefined)
      ) {
        throw new TypeError("Declare access once. permissions() cannot be combined with read, writes, or team.");
      }
      const compiled = compilePermissions(fields, policy);
      const next: TableOptions<TFields> = {};
      if (options.storage !== undefined) next.storage = options.storage;
      if (options.indexes !== undefined) next.indexes = options.indexes;
      next.read = compiled.read;
      if (compiled.writes !== undefined) next.writes = compiled.writes;
      if (compiled.team) {
        next.team = {
          field: compiled.team.field as Extract<keyof TFields, string>,
          ...(compiled.team.readRoles ? { readRoles: compiled.team.readRoles } : {}),
          ...(compiled.team.writeRoles ? { writeRoles: compiled.team.writeRoles } : {}),
          ...(compiled.team.ownerWrite ? { ownerWrite: true } : {}),
          ...(compiled.team.writes ? { writes: "none" as const } : {}),
        };
      }
      return defineTable(fields, next, "permissions");
    },
  });
  return withPermissions;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const RESERVED_FIELDS = new Set([
  "id",
  "ownerId",
  "createdAt",
  "updatedAt",
  "update",
  "delete",
  "toJSON",
  "__proto__",
  "prototype",
  "constructor",
]);
/** Columns of `_armadillo_users`, plus credential and payload names profile JSON must not shadow. */
const USER_COLUMNS = new Set([
  "app_id",
  "id",
  "email",
  "name",
  "password",
  "password_hash",
  "password_salt",
  "password_iterations",
  "created_at",
  "updated_at",
  "password_enabled",
  "profile_photo_id",
  "profile",
  "createdAt",
  "updatedAt",
  "profilePhotoId",
]);
const USER_EXTENSION_KIND = "armadillo.users";
const USER_FIELD_TYPES = new Set(["string", "boolean", "number", "integer", "file"]);

export interface UserExtension<TFields extends FieldMap = FieldMap> {
  readonly kind: typeof USER_EXTENSION_KIND;
  readonly fields: TFields;
}

function isUserExtension(value: unknown): value is UserExtension {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === USER_EXTENSION_KIND;
}

function publishedField(config: NormalizedField, keepUnique: boolean): NormalizedField {
  return {
    type: config.type,
    required: config.required,
    ...(config.nullable ? { nullable: true } : {}),
    ...(config.format === undefined ? {} : { format: config.format }),
    ...(config.default === undefined ? {} : { default: config.default }),
    ...(config.min === undefined ? {} : { min: config.min }),
    ...(config.max === undefined ? {} : { max: config.max }),
    ...(config.target === undefined ? {} : { target: config.target }),
    ...(config.contentTypes === undefined ? {} : { contentTypes: config.contentTypes }),
    ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
    ...(config.geoIndex === undefined ? {} : { geoIndex: config.geoIndex }),
    ...(config.minAltitude === undefined ? {} : { minAltitude: config.minAltitude }),
    ...(config.maxAltitude === undefined ? {} : { maxAltitude: config.maxAltitude }),
    ...(keepUnique && config.unique ? { unique: true } : {}),
    ...(config.supply !== undefined ? { supply: config.supply } : {}),
  };
}

function assertUserExtensionFields(fields: FieldMap): void {
  for (const fieldName of Object.keys(fields)) {
    if (!FIELD.test(fieldName)) throw new TypeError(`Schema field name \`${fieldName}\` is invalid.`);
    if (RESERVED_FIELDS.has(fieldName) || USER_COLUMNS.has(fieldName)) {
      throw new TypeError(`users.extend cannot redeclare \`${fieldName}\`.`);
    }
    const field: unknown = fields[fieldName];
    if (isUserExtension(field)) throw new TypeError("users.extend rejects a nested extend.");
    if (!field || typeof field !== "object" || !("config" in field)) {
      throw new TypeError(`users.extend rejects \`${fieldName}\`.`);
    }
    const type = (field as AnyField).config?.type;
    if (type === "pointer") throw new TypeError(`users.extend rejects relation on \`${fieldName}\`.`);
    if (type === "json") throw new TypeError(`users.extend rejects json on \`${fieldName}\`.`);
    if (!USER_FIELD_TYPES.has(type)) {
      throw new TypeError(`users.extend rejects \`${String(type ?? fieldName)}\` on \`${fieldName}\`.`);
    }
  }
}

function normalizeUserFields(fields: FieldMap): Record<string, NormalizedField> {
  assertUserExtensionFields(fields);
  const normalized: Record<string, NormalizedField> = Object.create(null) as Record<
    string,
    NormalizedField
  >;
  for (const fieldName of Object.keys(fields).sort()) {
    const field = fields[fieldName];
    if (!field) continue;
    const config = { ...field.config };
    if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
      throw new TypeError(`Schema field \`users.${fieldName}\` has min greater than max.`);
    }
    if (config.default !== undefined) {
      const issue = validateField(config.default, config);
      if (issue) throw new TypeError(`Schema field \`users.${fieldName}\` has a default that its own rule rejects: ${issue}.`);
    }
    normalized[fieldName] = publishedField(config, true);
  }
  return normalized;
}

/** The only legal value of the `users` key in `defineSchema`. */
export const users = {
  extend<const TFields extends FieldMap>(fields: TFields): UserExtension<TFields> {
    assertUserExtensionFields(fields);
    return { kind: USER_EXTENSION_KIND, fields };
  },
};

export function schema<const TTables extends Record<string, TableDefinition>>(
  tables: TTables,
): ExplainedSchema<TTables> {
  // Null-prototype maps. Every table and field lookup below is driven by a
  // caller-supplied name (`POST /v1/tables/:table`, `{"expands":["constructor"]}`),
  // and a normal object literal answers `constructor`, `toString`, and the rest
  // of `Object.prototype` from its prototype chain. That turned an unknown table
  // into an uncaught `TypeError` deep in the query planner — a 500 where the
  // contract says 404. A null prototype makes an unknown name simply unknown.
  const normalizedTables: Record<string, NormalizedTable> = Object.create(null) as Record<
    string,
    NormalizedTable
  >;

  for (const tableName of Object.keys(tables).sort()) {
    if (tableName === "users") {
      throw new TypeError("The key `users` is only `users.extend(...)`.");
    }
    if (!NAME.test(tableName)) throw new TypeError(`Schema table name \`${tableName}\` is invalid.`);
    const definition = tables[tableName];
    if (!definition) continue;
    const fields: Record<string, NormalizedField> = Object.create(null) as Record<
      string,
      NormalizedField
    >;
    const computeds: Record<string, { type: "string" | "integer" | "boolean" }> = Object.create(
      null,
    ) as Record<string, { type: "string" | "integer" | "boolean" }>;
    const indexes: Record<string, NormalizedIndex> = { ...definition.indexes };

    for (const fieldName of Object.keys(definition.fields).sort()) {
      if (!FIELD.test(fieldName)) throw new TypeError(`Schema field name \`${fieldName}\` is invalid.`);
      if (RESERVED_FIELDS.has(fieldName)) {
        throw new TypeError(`Schema field name \`${fieldName}\` is reserved by Armadillo.`);
      }
      const field = definition.fields[fieldName];
      if (!field) continue;
      const config = { ...field.config };
      if (config.type === "computed") {
        if (!config.computedType) {
          throw new TypeError(`Schema computed field \`${tableName}.${fieldName}\` has no result type.`);
        }
        computeds[fieldName] = { type: config.computedType };
        continue;
      }
      if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
        throw new TypeError(`Schema field \`${tableName}.${fieldName}\` has min greater than max.`);
      }
      if (config.default !== undefined) {
        const issue = validateField(config.default, config);
        if (issue) throw new TypeError(`Schema field \`${tableName}.${fieldName}\` has a default that its own rule rejects: ${issue}.`);
        if (config.type === "json" && config.default !== null) config.default = stableJson(config.default as SchemaJsonValue);
      }
      if (config.unique) {
        if (definition.storage !== "columns") {
          throw new TypeError(`\`unique()\` needs column storage on \`${tableName}.${fieldName}\``);
        }
        const indexName = `${fieldName}_unique`;
        const nextIndex: NormalizedIndex = { fields: [fieldName], unique: true };
        const existing = indexes[indexName];
        if (
          existing
          && !(existing.unique === true && existing.fields.length === 1 && existing.fields[0] === fieldName)
        ) {
          throw new TypeError(`Schema index \`${indexName}\` conflicts with unique() on \`${tableName}.${fieldName}\`.`);
        }
        indexes[indexName] = nextIndex;
      }
      fields[fieldName] = publishedField(config, false);
    }
    normalizedTables[tableName] = {
      fields,
      computeds,
      read: definition.read,
      storage: definition.storage,
      indexes,
      ...(definition.team ? { team: definition.team } : {}),
      ...(definition.writes === "none" ? { writes: "none" as const } : {}),
    };
  }

  for (const [tableName, definition] of Object.entries(normalizedTables)) {
    for (const [fieldName, field] of Object.entries(definition.fields)) {
      if (field.type !== "pointer") continue;
      const target = field.target ?? "";
      if (target !== "_User" && target !== "_Team" && !normalizedTables[target]) {
        throw new TypeError(
          `\`${tableName}.${fieldName}\` targets unknown table \`${target}\``,
        );
      }
    }
  }

  const defined: ExplainedSchema<TTables> = {
    tables,
    normalized: { tables: normalizedTables },
    explain() {
      return explainSchema(defined);
    },
  };
  return defined;
}

/** `schema()` after the `users` key is lifted off into the profile IR. */
export function defineSchema<const TInput extends Record<string, TableDefinition | UserExtension>>(
  input: TInput,
): ExplainedSchema<Record<string, TableDefinition>> {
  let extension: UserExtension | undefined;
  if (Object.hasOwn(input, "users")) {
    if (!isUserExtension(input.users)) {
      throw new TypeError("The key `users` is only `users.extend(...)`.");
    }
    extension = input.users;
  }
  const tables: Record<string, TableDefinition> = {};
  for (const key of Object.keys(input)) {
    if (key === "users") continue;
    const value = input[key];
    if (!value) continue;
    if (isUserExtension(value)) throw new TypeError("users.extend is only valid on the `users` key.");
    tables[key] = value as TableDefinition;
  }
  const defined = schema(tables);
  if (extension) defined.normalized.users = { fields: normalizeUserFields(extension.fields) };
  return defined;
}

type FieldValue<TField> = TField extends FieldDefinition<infer TValue, boolean, boolean>
  ? TValue
  : never;

type ComputedKeys<TFields extends FieldMap> = {
  [TKey in keyof TFields]: TFields[TKey] extends { readonly __computed: true } ? TKey : never;
}[keyof TFields];

type RequiredCreateKeys<TFields extends FieldMap> = Exclude<{
  [TKey in keyof TFields]: TFields[TKey] extends FieldDefinition<
    unknown,
    true,
    false
  > ? TKey : never;
}[keyof TFields], ComputedKeys<TFields>>;

type OptionalCreateKeys<TFields extends FieldMap> = Exclude<
  keyof TFields,
  RequiredCreateKeys<TFields> | ComputedKeys<TFields>
>;

type OptionalRecordKeys<TFields extends FieldMap> = {
  [TKey in keyof TFields]: TFields[TKey] extends FieldDefinition<
    unknown,
    false,
    false
  > ? TKey : never;
}[keyof TFields];

type RequiredRecordKeys<TFields extends FieldMap> = Exclude<
  keyof TFields,
  OptionalRecordKeys<TFields> | ComputedKeys<TFields>
>;

export type SchemaCreateData<TTable extends TableDefinition> = {
  [TKey in RequiredCreateKeys<TTable["fields"]>]: FieldValue<TTable["fields"][TKey]>;
} & {
  [TKey in OptionalCreateKeys<TTable["fields"]>]?: FieldValue<TTable["fields"][TKey]>;
};

/**
 * The input shape represented by a standalone group of Armadillo fields.
 *
 * This is useful for typed function contracts, where there is no persisted
 * table but the input deserves the same validation and inference as one.
 */
export type FieldMapInput<TFields extends FieldMap> = {
  [TKey in RequiredCreateKeys<TFields>]: FieldValue<TFields[TKey]>;
} & {
  [TKey in OptionalCreateKeys<TFields>]?: FieldValue<TFields[TKey]>;
};

export type SchemaRecordData<TTable extends TableDefinition> = {
  [TKey in RequiredRecordKeys<TTable["fields"]>]: FieldValue<TTable["fields"][TKey]>;
} & {
  [TKey in OptionalRecordKeys<TTable["fields"]>]?: FieldValue<TTable["fields"][TKey]>;
} & {
  readonly [TKey in ComputedKeys<TTable["fields"]>]: FieldValue<TTable["fields"][TKey]>;
};

type InferredSchema<TSchema extends SchemaDefinition> = {
  [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition
    ? SchemaRecordData<TSchema["tables"][TName]>
    : never;
};

type InferredSchemaCreate<TSchema extends SchemaDefinition> = {
  [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition
    ? SchemaCreateData<TSchema["tables"][TName]>
    : never;
};

/** Type helpers merged onto the `schema()` function, similar to `z.infer`. */
export namespace schema {
  export type infer<TSchema extends SchemaDefinition> = InferredSchema<TSchema>;
  export type create<TSchema extends SchemaDefinition> = InferredSchemaCreate<TSchema>;
  export type record<
    TSchema extends SchemaDefinition,
    TName extends keyof InferredSchema<TSchema>,
  > = InferredSchema<TSchema>[TName];
}

export class SchemaValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super("Object does not match its Armadillo schema.");
    this.name = "SchemaValidationError";
    this.fields = fields;
  }
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ticketSupplyIssue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Expected an object with supply";
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "sold") || Object.hasOwn(record, "remaining")) {
    return "Patching sold or remaining is not allowed";
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "supply") return "Only supply can be changed";
  const supply = record.supply;
  if (typeof supply !== "number" || !Number.isSafeInteger(supply) || supply < 0) {
    return "Supply must be an integer greater than or equal to the number sold";
  }
  return undefined;
}

/** Stored tickets value. Accepts the object or the TEXT JSON column form. */
export function readStoredTickets(value: unknown): { supply: number | null; sold: number } | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const supply = (parsed as { supply?: unknown }).supply;
  const sold = (parsed as { sold?: unknown }).sold;
  if (supply !== null && (typeof supply !== "number" || !Number.isFinite(supply))) return undefined;
  if (typeof sold !== "number" || !Number.isFinite(sold)) return undefined;
  return { supply: supply === null ? null : supply, sold };
}

/** `supply - sold` when supply is set. Unset supply is null, not unlimited. */
export function ticketRemaining(value: unknown): number | null {
  const state = readStoredTickets(value);
  if (!state || state.supply === null) return null;
  return state.supply - state.sold;
}

/** Replace stored `{ supply, sold }` with `{ remaining }` on the way out. */
export function projectStoredTickets<T extends Record<string, unknown>>(
  definition: SchemaDefinition | undefined,
  collection: string,
  record: T,
): T {
  const fields = definition?.normalized.tables[collection]?.fields;
  if (!fields) return record;
  let copy: Record<string, unknown> | undefined;
  for (const [name, field] of Object.entries(fields)) {
    if (field.type !== "tickets") continue;
    copy ??= { ...record };
    copy[name] = { remaining: ticketRemaining(copy[name]) };
  }
  return (copy ?? record) as T;
}

/**
 * Keep `sold` when a patch sets `supply`. Supply below `sold` throws.
 * The record route calls this because a shallow merge would drop `sold`.
 */
export function mergeTicketSupply(
  definition: SchemaDefinition | undefined,
  collection: string,
  existing: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...changes };
  const fields = definition?.normalized.tables[collection]?.fields;
  if (!fields) return merged;
  for (const [name, field] of Object.entries(fields)) {
    if (field.type !== "tickets" || !Object.hasOwn(changes, name)) continue;
    const patch = changes[name];
    const supply = patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as { supply?: unknown }).supply
      : undefined;
    const sold = readStoredTickets(existing[name])?.sold ?? 0;
    if (typeof supply !== "number" || !Number.isSafeInteger(supply) || supply < sold) {
      throw new SchemaValidationError({
        [name]: "Supply must be an integer greater than or equal to the number sold",
      });
    }
    merged[name] = { supply, sold };
  }
  return merged;
}

function validateField(value: unknown, field: NormalizedField): string | undefined {
  if (value === null && field.nullable) return undefined;
  if (field.type === "tickets") return "Tickets inventory is assigned by the schema";
  if (field.type === "string" || field.type === "email" || field.type === "pointer" || field.type === "file") {
    if (typeof value !== "string") return "Expected a string";
    if (field.format === "date-time") {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
      if (!match || !Number.isFinite(Date.parse(value))) return "Expected an RFC 3339 date-time with a timezone";
      const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
      const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
        || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
        || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return "Expected a valid calendar date-time";
    }
    if (field.format === "date" && !calendarDate(value)) return "Expected a calendar date, YYYY-MM-DD";
    if (field.type === "email" && (!/^\S+@\S+\.\S+$/.test(value) || value.length > 254)) {
      return "Expected a valid email address";
    }
    if (field.min !== undefined && value.length < field.min) return `Use at least ${field.min} characters`;
    if (field.max !== undefined && value.length > field.max) return `Use at most ${field.max} characters`;
    if (field.type === "pointer" && (value.length === 0 || value.length > 160)) {
      return "Expected a record id";
    }
    if (field.type === "file" && (value.length === 0 || value.length > 160)) {
      return "Expected an uploaded file id";
    }
    return undefined;
  }
  if (field.type === "json") {
    if (value === null) return "Expected a JSON value";
    const issue = jsonShape(value);
    if (issue) return issue;
    if (field.min !== undefined || field.max !== undefined) {
      const length = JSON.stringify(stableJson(value as SchemaJsonValue)).length;
      if (field.min !== undefined && length < field.min) return `Use at least ${field.min} characters of JSON`;
      if (field.max !== undefined && length > field.max) return `Use at most ${field.max} characters of JSON`;
    }
    return undefined;
  }
  if (field.type === "integer" || field.type === "number") {
    const finite = typeof value === "number" && Number.isFinite(value);
    if (field.type === "integer" && !Number.isInteger(value)) return "Expected an integer";
    if (field.type === "number" && !finite) return "Expected a finite number";
    if (field.min !== undefined && (value as number) < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && (value as number) > field.max) return `Must be at most ${field.max}`;
    return undefined;
  }
  if (field.type === "geo") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "Expected a geographic point";
    }
    const point = value as Record<string, unknown>;
    if (typeof point.latitude !== "number" || !Number.isFinite(point.latitude)
      || point.latitude < -90 || point.latitude > 90) {
      return "Latitude must be between -90 and 90";
    }
    if (typeof point.longitude !== "number" || !Number.isFinite(point.longitude)
      || point.longitude < -180 || point.longitude > 180) {
      return "Longitude must be between -180 and 180";
    }
    if (point.altitude !== undefined && (typeof point.altitude !== "number" || !Number.isFinite(point.altitude))) {
      return "Altitude must be a finite number";
    }
    if (typeof point.altitude === "number" && field.minAltitude !== undefined
      && point.altitude < field.minAltitude) {
      return `Altitude must be at least ${field.minAltitude}`;
    }
    if (typeof point.altitude === "number" && field.maxAltitude !== undefined
      && point.altitude > field.maxAltitude) {
      return `Altitude must be at most ${field.maxAltitude}`;
    }
    const keys = Object.keys(point);
    if (keys.some((key) => !["latitude", "longitude", "altitude"].includes(key))) {
      return "A geographic point only accepts latitude, longitude, and altitude";
    }
    return undefined;
  }
  if (typeof value !== "boolean") return "Expected a boolean";
  return undefined;
}

export function userProfileJsonPath(field: string): string {
  if (!FIELD.test(field)) throw new TypeError(`Profile field \`${field}\` is invalid.`);
  return `$.${field}`;
}

export function userProfileUniqueIndexSql(field: string): string {
  const path = userProfileJsonPath(field);
  return `CREATE UNIQUE INDEX IF NOT EXISTS _armadillo_users_profile_${field}_unique\n  ON _armadillo_users (app_id, json_extract(profile, '${path}'))\n  WHERE json_extract(profile, '${path}') IS NOT NULL;`;
}

export function dropUserProfileUniqueIndexSql(field: string): string {
  userProfileJsonPath(field);
  return `DROP INDEX IF EXISTS _armadillo_users_profile_${field}_unique;`;
}

export function removedUserProfileFields(
  current: NormalizedSchema | undefined,
  desired: NormalizedSchema,
): string[] {
  const previous = current?.users?.fields ?? {};
  const next = desired.users?.fields ?? {};
  return Object.keys(previous).filter((field) => !Object.hasOwn(next, field)).sort();
}

export function uniqueUserProfileFields(definition: NormalizedSchema | undefined): string[] {
  return Object.entries(definition?.users?.fields ?? {})
    .filter(([, field]) => field.unique === true)
    .map(([field]) => field)
    .sort();
}

export function encodeUserProfile(profile: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(profile).sort()) ordered[key] = profile[key];
  return JSON.stringify(ordered);
}

/**
 * Merge a profile write. Missing keys stay absent. A required file may be
 * absent on create because the user cannot own a file until they exist.
 */
export function assignUserProfile(
  fields: Record<string, NormalizedField>,
  current: Record<string, unknown>,
  assignments: Record<string, unknown>,
  mode: "create" | "patch",
): Record<string, unknown> {
  const issues: Record<string, string> = {};
  for (const key of Object.keys(assignments)) {
    if (!Object.hasOwn(fields, key)) issues[key] = "Field is not in this profile";
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (Object.hasOwn(fields, key) && value !== undefined) next[key] = value;
  }
  if (mode === "create") {
    for (const [key, field] of Object.entries(fields)) {
      if (Object.hasOwn(assignments, key)) continue;
      if (field.default !== undefined) next[key] = field.default;
      else if (field.required && field.type !== "file") issues[key] = "Field is required";
    }
  }
  for (const [key, value] of Object.entries(assignments)) {
    const field = fields[key];
    if (!field) continue;
    const issue = validateField(value, field);
    if (issue) issues[key] = issue;
    else if (value !== undefined) next[key] = value;
  }
  if (Object.keys(issues).length > 0) throw new SchemaValidationError(issues);
  return next;
}

/** @internal */
export function validateSchemaData(
  definition: SchemaDefinition | undefined,
  tableName: string,
  data: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const tableSchema = definition?.normalized.tables[tableName];
  if (!tableSchema) return data;

  const result = { ...data };
  const issues: Record<string, string> = {};
  for (const fieldName of Object.keys(data)) {
    if (!tableSchema.fields[fieldName]) issues[fieldName] = "Field is not in this table's schema";
  }

  for (const [fieldName, field] of Object.entries(tableSchema.fields)) {
    if (field.type === "tickets") {
      if (!(fieldName in result)) {
        if (!partial) result[fieldName] = { supply: field.supply ?? null, sold: 0 };
        continue;
      }
      if (!partial) {
        issues[fieldName] = "Tickets inventory is assigned by the schema";
        continue;
      }
      const issue = ticketSupplyIssue(result[fieldName]);
      if (issue) issues[fieldName] = issue;
      else result[fieldName] = { supply: (result[fieldName] as { supply: number }).supply };
      continue;
    }
    if (!(fieldName in result)) {
      if (!partial && field.default !== undefined) result[fieldName] = field.default;
      else if (!partial && field.required) issues[fieldName] = "Field is required";
      continue;
    }
    const issue = validateField(result[fieldName], field);
    if (issue) issues[fieldName] = issue;
    else if (field.type === "json" && result[fieldName] !== null && result[fieldName] !== undefined) {
      result[fieldName] = stableJson(result[fieldName] as SchemaJsonValue);
    }
  }

  if (Object.keys(issues).length > 0) throw new SchemaValidationError(issues);
  return result;
}

/**
 * Validate a standalone field map without applying table-only restrictions to
 * its keys. Function contracts use this so common JSON names such as `id` are
 * valid while persisted records keep their reserved metadata fields.
 */
export function validateFieldMapData(
  fields: FieldMap,
  data: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const definition: SchemaDefinition = {
    tables: {},
    normalized: {
      tables: {
        FunctionContract: {
          fields: Object.assign(
            Object.create(null) as Record<string, NormalizedField>,
            Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.config])),
          ),
          read: "owner",
          storage: "json",
          indexes: {},
        },
      },
    },
  };
  return validateSchemaData(definition, "FunctionContract", data, partial);
}

export interface JunkDrawerTeamOptions {
  field?: string;
  readRoles?: string[];
  writeRoles?: string[];
  ownerWrite?: boolean;
  writes?: "none";
}

export interface JunkDrawerOptions {
  /**
   * Who may read records: "owner" (private to creator) or "public" (readable by anyone).
   * Default is "owner".
   */
  read?: "owner" | "public";
  /**
   * Set to "none" to close ordinary REST writes (creates/updates/deletes) and require custom functions.
   */
  writes?: "none";
  /**
   * Share records within a team or group.
   */
  team?: JunkDrawerTeamOptions;
}

/**
 * A schemaless document table with Parse-like semantics.
 * Stores arbitrary JSON in a validated `content` field with server-assigned ID,
 * authenticated owner, timestamps, and full Armadillo permission enforcement.
 *
 * @example
 * export default schema({
 *   JunkDrawer: junkDrawer(),
 *   SharedNotes: junkDrawer({ team: { readRoles: ["member"], writeRoles: ["editor", "owner"] } }),
 *   PublicFeed: junkDrawer({ read: "public" }),
 * });
 */
export function junkDrawer(
  options: JunkDrawerOptions = {},
): DefinedTable<{ readonly [field: string]: FieldDefinition<SchemaJsonValue, true, false> }> {
  if (options.team) {
    const teamField = options.team.field ?? "teamId";
    return table(
      {
        [teamField]: relation.team(),
        content: json(),
      },
      {
        read: options.read ?? "owner",
        ...(options.writes === "none" ? { writes: "none" as const } : {}),
        team: {
          field: teamField,
          ...(options.team.readRoles ? { readRoles: options.team.readRoles } : {}),
          ...(options.team.writeRoles ? { writeRoles: options.team.writeRoles } : {}),
          ...(options.team.ownerWrite ? { ownerWrite: true } : {}),
          ...(options.team.writes ? { writes: options.team.writes } : {}),
        },
      },
    );
  }
  return table(
    {
      content: json(),
    },
    {
      read: options.read ?? "owner",
      ...(options.writes === "none" ? { writes: "none" as const } : {}),
    },
  );
}
