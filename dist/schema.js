import {
  compilePermissions,
  explainSchema
} from "./access.js";
import {
  anyone,
  explainSchema as explainSchema2,
  members,
  nobody,
  owner,
  recordOwner,
  roles
} from "./access.js";
class FieldDefinition {
  /** @internal */
  config;
  /** @internal */
  constructor(config) {
    this.config = config;
  }
  /** Accept null explicitly, for example when clearing a pointer. */
  nullable() {
    return new FieldDefinition({ ...this.config, nullable: true });
  }
  /** Require a calendar date, `YYYY-MM-DD`. */
  date() {
    if (this.config.type !== "string") throw new TypeError("date() requires a string field.");
    if (this.config.format === "date-time") throw new TypeError("date() cannot be combined with datetime().");
    return new FieldDefinition({ ...this.config, format: "date" });
  }
  /** Require an RFC 3339 timestamp with an explicit UTC offset. */
  datetime() {
    if (this.config.type !== "string") throw new TypeError("datetime() requires a string field.");
    if (this.config.format === "date") throw new TypeError("datetime() cannot be combined with date().");
    return new FieldDefinition({ ...this.config, format: "date-time" });
  }
  /** Validate the string as an email address. */
  email() {
    if (this.config.type !== "string" && this.config.type !== "email") {
      throw new TypeError("email() requires a string field.");
    }
    if (this.config.format) throw new TypeError("email() cannot be combined with date() or datetime().");
    return new FieldDefinition({ ...this.config, type: "email" });
  }
  optional() {
    return new FieldDefinition({ ...this.config, required: false });
  }
  default(value) {
    return new FieldDefinition({ ...this.config, default: value });
  }
  /** One value per row. Legal on text, email, and integer. */
  unique() {
    if (this.config.type !== "string" && this.config.type !== "email" && this.config.type !== "integer") {
      throw new TypeError("unique() is only legal on text, email, and integer.");
    }
    return new FieldDefinition({ ...this.config, unique: true });
  }
  min(value) {
    return new FieldDefinition({ ...this.config, min: value });
  }
  max(value) {
    return new FieldDefinition({ ...this.config, max: value });
  }
}
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;
const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i;
const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
function bytes(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("File size must be a positive byte count.");
    return value;
  }
  const match = SIZE.exec(value.trim());
  const unit = match?.[2]?.toLowerCase();
  const amount = Number(match?.[1]);
  const result = unit ? Math.round(amount * SIZE_UNITS[unit]) : Number.NaN;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError("File size must look like `500 KB`, `10 MB`, or a positive byte count.");
  }
  return result;
}
class FileFieldDefinition extends FieldDefinition {
  optional() {
    return new FileFieldDefinition({ ...this.config, required: false });
  }
  /** Accept one or more exact MIME types or wildcard families such as `image/*`. */
  accept(...contentTypes) {
    if (contentTypes.length === 0 || contentTypes.some((value) => !MIME.test(value))) {
      throw new TypeError("File content types must look like `application/pdf` or `image/*`.");
    }
    return new FileFieldDefinition({
      ...this.config,
      contentTypes: [...new Set(contentTypes.map((value) => value.toLowerCase()))].sort()
    });
  }
  /** Memorable alias for `accept()`. */
  contentType(...contentTypes) {
    return this.accept(...contentTypes);
  }
  /** Limit file size with bytes or a readable value such as `10 MB`. */
  maxSize(value) {
    return new FileFieldDefinition({ ...this.config, maxBytes: bytes(value) });
  }
}
function string() {
  return new FieldDefinition({ type: "string", required: true });
}
function text() {
  return string();
}
function email() {
  return new FieldDefinition({ type: "email", required: true });
}
function number() {
  return new FieldDefinition({ type: "number", required: true });
}
function integer() {
  return new FieldDefinition({ type: "integer", required: true });
}
function json() {
  return new FieldDefinition({ type: "json", required: true });
}
function jsonShape(value, seen) {
  const visiting = seen ?? /* @__PURE__ */ new WeakSet();
  if (value === void 0) return "JSON cannot contain undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") return void 0;
  if (typeof value === "number") return Number.isFinite(value) ? void 0 : "JSON numbers must be finite";
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
    return void 0;
  }
  for (const key of Object.keys(value)) {
    const issue = jsonShape(value[key], visiting);
    if (issue) {
      visiting.delete(value);
      return issue;
    }
  }
  visiting.delete(value);
  return void 0;
}
function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => stableJson(item));
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.value === void 0) continue;
    Object.defineProperty(result, key, {
      value: stableJson(descriptor.value),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return result;
}
function boolean() {
  return new FieldDefinition({ type: "boolean", required: true });
}
function bool() {
  return boolean();
}
class PointerFieldDefinition extends FieldDefinition {
  optional() {
    return new PointerFieldDefinition({ ...this.config, required: false });
  }
  default(value) {
    return new PointerFieldDefinition({ ...this.config, default: value });
  }
  min(value) {
    return new PointerFieldDefinition({ ...this.config, min: value });
  }
  max(value) {
    return new PointerFieldDefinition({ ...this.config, max: value });
  }
}
function pointer(target) {
  return new PointerFieldDefinition({ type: "pointer", required: true, target });
}
function ref(target) {
  if (target === "files") return file();
  if (target === "users") return relation.user();
  return pointer(target);
}
function relation(target) {
  return pointer(target);
}
((relation2) => {
  function user() {
    return pointer("_User");
  }
  relation2.user = user;
  function team() {
    return pointer("_Team");
  }
  relation2.team = team;
})(relation || (relation = {}));
function file() {
  return new FileFieldDefinition({ type: "file", required: true });
}
function tickets(options) {
  const supply = options?.supply;
  if (supply !== void 0 && (!Number.isSafeInteger(supply) || supply < 0)) {
    throw new TypeError("tickets supply must be a non-negative integer.");
  }
  return new FieldDefinition({
    type: "tickets",
    required: false,
    ...supply !== void 0 ? { supply } : {}
  });
}
function table(fields, options = {}) {
  return defineTable(fields, options, "options");
}
function defineTable(fields, options, source) {
  const indexes = {};
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
    throw new TypeError('Declared indexes require `storage: "columns"`.');
  }
  if (options.writes !== void 0 && options.writes !== "none") {
    throw new TypeError('Table writes must be "none" when set.');
  }
  if (options.writes === "none" && (options.team?.writeRoles !== void 0 || options.team?.ownerWrite)) {
    throw new TypeError('writes: "none" cannot be combined with writeRoles or ownerWrite.');
  }
  if ((options.storage ?? "json") === "json" && Object.values(fields).some((field) => field.config.type === "geo" && field.config.geoIndex)) {
    throw new TypeError('Geo indexes require `storage: "columns"`.');
  }
  let team;
  if (options.team) {
    const field = fields[options.team.field];
    if (field?.config.type !== "pointer" || field.config.target !== "_Team") {
      throw new TypeError('Team access must reference a `relation.team()` or `ref("_Team")` field.');
    }
    if ((options.read ?? "owner") === "public") {
      throw new TypeError("A public table cannot also use team-scoped access.");
    }
    const roles2 = (values, label) => {
      if (values === void 0) return void 0;
      if (values.length === 0 || values.some((role) => !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) {
        throw new TypeError(`${label} must contain one or more valid team roles.`);
      }
      return [...new Set(values)].sort();
    };
    if (options.team.writes !== void 0 && options.team.writes !== "none") {
      throw new TypeError('Team writes must be "none" when set.');
    }
    if (options.team.writes === "none" && (options.team.writeRoles !== void 0 || options.team.ownerWrite)) {
      throw new TypeError('Team writes: "none" cannot be combined with writeRoles or ownerWrite.');
    }
    const readRoles = roles2(options.team.readRoles, "readRoles");
    const writeRoles = roles2(options.team.writeRoles, "writeRoles");
    team = {
      field: options.team.field,
      ...readRoles ? { readRoles } : {},
      ...writeRoles ? { writeRoles } : {},
      ...options.team.ownerWrite ? { ownerWrite: true } : {},
      ...options.team.writes === "none" ? { writes: "none" } : {}
    };
  }
  const defined = {
    fields,
    read: options.read ?? "owner",
    storage: options.storage ?? "json",
    indexes,
    ...team ? { team } : {},
    ...options.writes === "none" ? { writes: "none" } : {}
  };
  const withPermissions = defined;
  Object.defineProperty(withPermissions, "permissions", {
    enumerable: false,
    value: (policy) => {
      if (source === "options" && (options.read !== void 0 || options.writes !== void 0 || options.team !== void 0)) {
        throw new TypeError("Declare access once. permissions() cannot be combined with read, writes, or team.");
      }
      const compiled = compilePermissions(fields, policy);
      const next = {};
      if (options.storage !== void 0) next.storage = options.storage;
      if (options.indexes !== void 0) next.indexes = options.indexes;
      next.read = compiled.read;
      if (compiled.writes !== void 0) next.writes = compiled.writes;
      if (compiled.team) {
        next.team = {
          field: compiled.team.field,
          ...compiled.team.readRoles ? { readRoles: compiled.team.readRoles } : {},
          ...compiled.team.writeRoles ? { writeRoles: compiled.team.writeRoles } : {},
          ...compiled.team.ownerWrite ? { ownerWrite: true } : {},
          ...compiled.team.writes ? { writes: "none" } : {}
        };
      }
      return defineTable(fields, next, "permissions");
    }
  });
  return withPermissions;
}
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const RESERVED_FIELDS = /* @__PURE__ */ new Set([
  "id",
  "ownerId",
  "createdAt",
  "updatedAt",
  "update",
  "delete",
  "toJSON",
  "__proto__",
  "prototype",
  "constructor"
]);
const USER_COLUMNS = /* @__PURE__ */ new Set([
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
  "profilePhotoId"
]);
const USER_EXTENSION_KIND = "armadillo.users";
const USER_FIELD_TYPES = /* @__PURE__ */ new Set(["string", "boolean", "number", "integer", "file"]);
function isUserExtension(value) {
  return !!value && typeof value === "object" && value.kind === USER_EXTENSION_KIND;
}
function publishedField(config, keepUnique) {
  return {
    type: config.type,
    required: config.required,
    ...config.nullable ? { nullable: true } : {},
    ...config.format === void 0 ? {} : { format: config.format },
    ...config.default === void 0 ? {} : { default: config.default },
    ...config.min === void 0 ? {} : { min: config.min },
    ...config.max === void 0 ? {} : { max: config.max },
    ...config.target === void 0 ? {} : { target: config.target },
    ...config.contentTypes === void 0 ? {} : { contentTypes: config.contentTypes },
    ...config.maxBytes === void 0 ? {} : { maxBytes: config.maxBytes },
    ...config.geoIndex === void 0 ? {} : { geoIndex: config.geoIndex },
    ...config.minAltitude === void 0 ? {} : { minAltitude: config.minAltitude },
    ...config.maxAltitude === void 0 ? {} : { maxAltitude: config.maxAltitude },
    ...keepUnique && config.unique ? { unique: true } : {},
    ...config.supply !== void 0 ? { supply: config.supply } : {}
  };
}
function assertUserExtensionFields(fields) {
  for (const fieldName of Object.keys(fields)) {
    if (!FIELD.test(fieldName)) throw new TypeError(`Schema field name \`${fieldName}\` is invalid.`);
    if (RESERVED_FIELDS.has(fieldName) || USER_COLUMNS.has(fieldName)) {
      throw new TypeError(`users.extend cannot redeclare \`${fieldName}\`.`);
    }
    const field = fields[fieldName];
    if (isUserExtension(field)) throw new TypeError("users.extend rejects a nested extend.");
    if (!field || typeof field !== "object" || !("config" in field)) {
      throw new TypeError(`users.extend rejects \`${fieldName}\`.`);
    }
    const type = field.config?.type;
    if (type === "pointer") throw new TypeError(`users.extend rejects relation on \`${fieldName}\`.`);
    if (type === "json") throw new TypeError(`users.extend rejects json on \`${fieldName}\`.`);
    if (!USER_FIELD_TYPES.has(type)) {
      throw new TypeError(`users.extend rejects \`${String(type ?? fieldName)}\` on \`${fieldName}\`.`);
    }
  }
}
function normalizeUserFields(fields) {
  assertUserExtensionFields(fields);
  const normalized = /* @__PURE__ */ Object.create(null);
  for (const fieldName of Object.keys(fields).sort()) {
    const field = fields[fieldName];
    if (!field) continue;
    const config = { ...field.config };
    if (config.min !== void 0 && config.max !== void 0 && config.min > config.max) {
      throw new TypeError(`Schema field \`users.${fieldName}\` has min greater than max.`);
    }
    if (config.default !== void 0) {
      const issue = validateField(config.default, config);
      if (issue) throw new TypeError(`Schema field \`users.${fieldName}\` has a default that its own rule rejects: ${issue}.`);
    }
    normalized[fieldName] = publishedField(config, true);
  }
  return normalized;
}
const users = {
  extend(fields) {
    assertUserExtensionFields(fields);
    return { kind: USER_EXTENSION_KIND, fields };
  }
};
function schema(tables) {
  const normalizedTables = /* @__PURE__ */ Object.create(null);
  for (const tableName of Object.keys(tables).sort()) {
    if (tableName === "users") {
      throw new TypeError("The key `users` is only `users.extend(...)`.");
    }
    if (!NAME.test(tableName)) throw new TypeError(`Schema table name \`${tableName}\` is invalid.`);
    const definition = tables[tableName];
    if (!definition) continue;
    const fields = /* @__PURE__ */ Object.create(null);
    const computeds = /* @__PURE__ */ Object.create(
      null
    );
    const indexes = { ...definition.indexes };
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
      if (config.min !== void 0 && config.max !== void 0 && config.min > config.max) {
        throw new TypeError(`Schema field \`${tableName}.${fieldName}\` has min greater than max.`);
      }
      if (config.default !== void 0) {
        const issue = validateField(config.default, config);
        if (issue) throw new TypeError(`Schema field \`${tableName}.${fieldName}\` has a default that its own rule rejects: ${issue}.`);
        if (config.type === "json" && config.default !== null) config.default = stableJson(config.default);
      }
      if (config.unique) {
        if (definition.storage !== "columns") {
          throw new TypeError(`\`unique()\` needs column storage on \`${tableName}.${fieldName}\``);
        }
        const indexName = `${fieldName}_unique`;
        const nextIndex = { fields: [fieldName], unique: true };
        const existing = indexes[indexName];
        if (existing && !(existing.unique === true && existing.fields.length === 1 && existing.fields[0] === fieldName)) {
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
      ...definition.team ? { team: definition.team } : {},
      ...definition.writes === "none" ? { writes: "none" } : {}
    };
  }
  for (const [tableName, definition] of Object.entries(normalizedTables)) {
    for (const [fieldName, field] of Object.entries(definition.fields)) {
      if (field.type !== "pointer") continue;
      const target = field.target ?? "";
      if (target !== "_User" && target !== "_Team" && !normalizedTables[target]) {
        throw new TypeError(
          `\`${tableName}.${fieldName}\` targets unknown table \`${target}\``
        );
      }
    }
  }
  const defined = {
    tables,
    normalized: { tables: normalizedTables },
    explain() {
      return explainSchema(defined);
    }
  };
  return defined;
}
function defineSchema(input) {
  let extension;
  if (Object.hasOwn(input, "users")) {
    if (!isUserExtension(input.users)) {
      throw new TypeError("The key `users` is only `users.extend(...)`.");
    }
    extension = input.users;
  }
  const tables = {};
  for (const key of Object.keys(input)) {
    if (key === "users") continue;
    const value = input[key];
    if (!value) continue;
    if (isUserExtension(value)) throw new TypeError("users.extend is only valid on the `users` key.");
    tables[key] = value;
  }
  const defined = schema(tables);
  if (extension) defined.normalized.users = { fields: normalizeUserFields(extension.fields) };
  return defined;
}
class SchemaValidationError extends Error {
  fields;
  constructor(fields) {
    super("Object does not match its Armadillo schema.");
    this.name = "SchemaValidationError";
    this.fields = fields;
  }
}
function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function ticketSupplyIssue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Expected an object with supply";
  }
  const record = value;
  if (Object.hasOwn(record, "sold") || Object.hasOwn(record, "remaining")) {
    return "Patching sold or remaining is not allowed";
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "supply") return "Only supply can be changed";
  const supply = record.supply;
  if (typeof supply !== "number" || !Number.isSafeInteger(supply) || supply < 0) {
    return "Supply must be an integer greater than or equal to the number sold";
  }
  return void 0;
}
function readStoredTickets(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return void 0;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
  const supply = parsed.supply;
  const sold = parsed.sold;
  if (supply !== null && (typeof supply !== "number" || !Number.isFinite(supply))) return void 0;
  if (typeof sold !== "number" || !Number.isFinite(sold)) return void 0;
  return { supply: supply === null ? null : supply, sold };
}
function ticketRemaining(value) {
  const state = readStoredTickets(value);
  if (!state || state.supply === null) return null;
  return state.supply - state.sold;
}
function projectStoredTickets(definition, collection, record) {
  const fields = definition?.normalized.tables[collection]?.fields;
  if (!fields) return record;
  let copy;
  for (const [name, field] of Object.entries(fields)) {
    if (field.type !== "tickets") continue;
    copy ??= { ...record };
    copy[name] = { remaining: ticketRemaining(copy[name]) };
  }
  return copy ?? record;
}
function mergeTicketSupply(definition, collection, existing, changes) {
  const merged = { ...existing, ...changes };
  const fields = definition?.normalized.tables[collection]?.fields;
  if (!fields) return merged;
  for (const [name, field] of Object.entries(fields)) {
    if (field.type !== "tickets" || !Object.hasOwn(changes, name)) continue;
    const patch = changes[name];
    const supply = patch && typeof patch === "object" && !Array.isArray(patch) ? patch.supply : void 0;
    const sold = readStoredTickets(existing[name])?.sold ?? 0;
    if (typeof supply !== "number" || !Number.isSafeInteger(supply) || supply < sold) {
      throw new SchemaValidationError({
        [name]: "Supply must be an integer greater than or equal to the number sold"
      });
    }
    merged[name] = { supply, sold };
  }
  return merged;
}
function validateField(value, field) {
  if (value === null && field.nullable) return void 0;
  if (field.type === "tickets") return "Tickets inventory is assigned by the schema";
  if (field.type === "string" || field.type === "email" || field.type === "pointer" || field.type === "file") {
    if (typeof value !== "string") return "Expected a string";
    if (field.format === "date-time") {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
      if (!match || !Number.isFinite(Date.parse(value))) return "Expected an RFC 3339 date-time with a timezone";
      const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
      const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return "Expected a valid calendar date-time";
    }
    if (field.format === "date" && !calendarDate(value)) return "Expected a calendar date, YYYY-MM-DD";
    if (field.type === "email" && (!/^\S+@\S+\.\S+$/.test(value) || value.length > 254)) {
      return "Expected a valid email address";
    }
    if (field.min !== void 0 && value.length < field.min) return `Use at least ${field.min} characters`;
    if (field.max !== void 0 && value.length > field.max) return `Use at most ${field.max} characters`;
    if (field.type === "pointer" && (value.length === 0 || value.length > 160)) {
      return "Expected a record id";
    }
    if (field.type === "file" && (value.length === 0 || value.length > 160)) {
      return "Expected an uploaded file id";
    }
    return void 0;
  }
  if (field.type === "json") {
    if (value === null) return "Expected a JSON value";
    const issue = jsonShape(value);
    if (issue) return issue;
    if (field.min !== void 0 || field.max !== void 0) {
      const length = JSON.stringify(stableJson(value)).length;
      if (field.min !== void 0 && length < field.min) return `Use at least ${field.min} characters of JSON`;
      if (field.max !== void 0 && length > field.max) return `Use at most ${field.max} characters of JSON`;
    }
    return void 0;
  }
  if (field.type === "integer" || field.type === "number") {
    const finite = typeof value === "number" && Number.isFinite(value);
    if (field.type === "integer" && !Number.isInteger(value)) return "Expected an integer";
    if (field.type === "number" && !finite) return "Expected a finite number";
    if (field.min !== void 0 && value < field.min) return `Must be at least ${field.min}`;
    if (field.max !== void 0 && value > field.max) return `Must be at most ${field.max}`;
    return void 0;
  }
  if (field.type === "geo") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "Expected a geographic point";
    }
    const point = value;
    if (typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
      return "Latitude must be between -90 and 90";
    }
    if (typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
      return "Longitude must be between -180 and 180";
    }
    if (point.altitude !== void 0 && (typeof point.altitude !== "number" || !Number.isFinite(point.altitude))) {
      return "Altitude must be a finite number";
    }
    if (typeof point.altitude === "number" && field.minAltitude !== void 0 && point.altitude < field.minAltitude) {
      return `Altitude must be at least ${field.minAltitude}`;
    }
    if (typeof point.altitude === "number" && field.maxAltitude !== void 0 && point.altitude > field.maxAltitude) {
      return `Altitude must be at most ${field.maxAltitude}`;
    }
    const keys = Object.keys(point);
    if (keys.some((key) => !["latitude", "longitude", "altitude"].includes(key))) {
      return "A geographic point only accepts latitude, longitude, and altitude";
    }
    return void 0;
  }
  if (typeof value !== "boolean") return "Expected a boolean";
  return void 0;
}
function userProfileJsonPath(field) {
  if (!FIELD.test(field)) throw new TypeError(`Profile field \`${field}\` is invalid.`);
  return `$.${field}`;
}
function userProfileUniqueIndexSql(field) {
  const path = userProfileJsonPath(field);
  return `CREATE UNIQUE INDEX IF NOT EXISTS _armadillo_users_profile_${field}_unique
  ON _armadillo_users (app_id, json_extract(profile, '${path}'))
  WHERE json_extract(profile, '${path}') IS NOT NULL;`;
}
function dropUserProfileUniqueIndexSql(field) {
  userProfileJsonPath(field);
  return `DROP INDEX IF EXISTS _armadillo_users_profile_${field}_unique;`;
}
function removedUserProfileFields(current, desired) {
  const previous = current?.users?.fields ?? {};
  const next = desired.users?.fields ?? {};
  return Object.keys(previous).filter((field) => !Object.hasOwn(next, field)).sort();
}
function uniqueUserProfileFields(definition) {
  return Object.entries(definition?.users?.fields ?? {}).filter(([, field]) => field.unique === true).map(([field]) => field).sort();
}
function encodeUserProfile(profile) {
  const ordered = /* @__PURE__ */ Object.create(null);
  for (const key of Object.keys(profile).sort()) ordered[key] = profile[key];
  return JSON.stringify(ordered);
}
function assignUserProfile(fields, current, assignments, mode) {
  const issues = {};
  for (const key of Object.keys(assignments)) {
    if (!Object.hasOwn(fields, key)) issues[key] = "Field is not in this profile";
  }
  const next = {};
  for (const [key, value] of Object.entries(current)) {
    if (Object.hasOwn(fields, key) && value !== void 0) next[key] = value;
  }
  if (mode === "create") {
    for (const [key, field] of Object.entries(fields)) {
      if (Object.hasOwn(assignments, key)) continue;
      if (field.default !== void 0) next[key] = field.default;
      else if (field.required && field.type !== "file") issues[key] = "Field is required";
    }
  }
  for (const [key, value] of Object.entries(assignments)) {
    const field = fields[key];
    if (!field) continue;
    const issue = validateField(value, field);
    if (issue) issues[key] = issue;
    else if (value !== void 0) next[key] = value;
  }
  if (Object.keys(issues).length > 0) throw new SchemaValidationError(issues);
  return next;
}
function validateSchemaData(definition, tableName, data, partial) {
  const tableSchema = definition?.normalized.tables[tableName];
  if (!tableSchema) return data;
  const result = { ...data };
  const issues = {};
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
      const issue2 = ticketSupplyIssue(result[fieldName]);
      if (issue2) issues[fieldName] = issue2;
      else result[fieldName] = { supply: result[fieldName].supply };
      continue;
    }
    if (!(fieldName in result)) {
      if (!partial && field.default !== void 0) result[fieldName] = field.default;
      else if (!partial && field.required) issues[fieldName] = "Field is required";
      continue;
    }
    const issue = validateField(result[fieldName], field);
    if (issue) issues[fieldName] = issue;
    else if (field.type === "json" && result[fieldName] !== null && result[fieldName] !== void 0) {
      result[fieldName] = stableJson(result[fieldName]);
    }
  }
  if (Object.keys(issues).length > 0) throw new SchemaValidationError(issues);
  return result;
}
function validateFieldMapData(fields, data, partial) {
  const definition = {
    tables: {},
    normalized: {
      tables: {
        FunctionContract: {
          fields: Object.assign(
            /* @__PURE__ */ Object.create(null),
            Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.config]))
          ),
          read: "owner",
          storage: "json",
          indexes: {}
        }
      }
    }
  };
  return validateSchemaData(definition, "FunctionContract", data, partial);
}
function junkDrawer(options = {}) {
  if (options.team) {
    const teamField = options.team.field ?? "teamId";
    return table(
      {
        [teamField]: relation.team(),
        content: json()
      },
      {
        read: options.read ?? "owner",
        ...options.writes === "none" ? { writes: "none" } : {},
        team: {
          field: teamField,
          ...options.team.readRoles ? { readRoles: options.team.readRoles } : {},
          ...options.team.writeRoles ? { writeRoles: options.team.writeRoles } : {},
          ...options.team.ownerWrite ? { ownerWrite: true } : {},
          ...options.team.writes ? { writes: options.team.writes } : {}
        }
      }
    );
  }
  return table(
    {
      content: json()
    },
    {
      read: options.read ?? "owner",
      ...options.writes === "none" ? { writes: "none" } : {}
    }
  );
}
export {
  FieldDefinition,
  FileFieldDefinition,
  PointerFieldDefinition,
  SchemaValidationError,
  anyone,
  assignUserProfile,
  bool,
  boolean,
  defineSchema,
  dropUserProfileUniqueIndexSql,
  email,
  encodeUserProfile,
  explainSchema2 as explainSchema,
  file,
  integer,
  json,
  junkDrawer,
  members,
  mergeTicketSupply,
  nobody,
  number,
  owner,
  pointer,
  projectStoredTickets,
  readStoredTickets,
  recordOwner,
  ref,
  relation,
  removedUserProfileFields,
  roles,
  schema,
  stableJson,
  string,
  table,
  text,
  ticketRemaining,
  tickets,
  uniqueUserProfileFields,
  userProfileJsonPath,
  userProfileUniqueIndexSql,
  users,
  validateFieldMapData,
  validateSchemaData
};
