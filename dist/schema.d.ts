import { type PermissionPolicy } from "./access.js";
export type { AccessTerm, PermissionPolicy, } from "./access.js";
export { anyone, explainSchema, members, nobody, owner, recordOwner, roles, } from "./access.js";
export type SchemaFieldType = "string" | "number" | "integer" | "json" | "boolean" | "email" | "pointer" | "file" | "computed" | "geo" | "tickets";
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
    computeds?: Record<string, {
        type: "string" | "integer" | "boolean";
    }>;
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
export declare class FieldDefinition<TValue, TRequired extends boolean = true, THasDefault extends boolean = false> {
    /** @internal Type-only marker used for schema inference. */
    readonly __types: {
        value: TValue;
        required: TRequired;
        hasDefault: THasDefault;
    };
    /** @internal */
    readonly config: NormalizedField;
    /** @internal */
    constructor(config: NormalizedField);
    /** Accept null explicitly, for example when clearing a pointer. */
    nullable(): FieldDefinition<TValue | null, TRequired, THasDefault>;
    /** Require a calendar date, `YYYY-MM-DD`. */
    date(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault>;
    /** Require an RFC 3339 timestamp with an explicit UTC offset. */
    datetime(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault>;
    /** Validate the string as an email address. */
    email(this: FieldDefinition<string, TRequired, THasDefault>): FieldDefinition<string, TRequired, THasDefault>;
    optional(): FieldDefinition<TValue, false, THasDefault>;
    default(value: TValue): FieldDefinition<TValue, TRequired, true>;
    /** One value per row. Legal on text, email, and integer. */
    unique(): FieldDefinition<TValue, TRequired, THasDefault>;
    min(value: number): FieldDefinition<TValue, TRequired, THasDefault>;
    max(value: number): FieldDefinition<TValue, TRequired, THasDefault>;
}
export declare class FileFieldDefinition<TRequired extends boolean = true> extends FieldDefinition<string, TRequired, false> {
    optional(): FileFieldDefinition<false>;
    /** Accept one or more exact MIME types or wildcard families such as `image/*`. */
    accept(...contentTypes: string[]): FileFieldDefinition<TRequired>;
    /** Memorable alias for `accept()`. */
    contentType(...contentTypes: string[]): FileFieldDefinition<TRequired>;
    /** Limit file size with bytes or a readable value such as `10 MB`. */
    maxSize(value: number | string): FileFieldDefinition<TRequired>;
}
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
export interface ExplainedSchema<TTables extends Record<string, TableDefinition> = Record<string, TableDefinition>> extends SchemaDefinition<TTables> {
    explain(): string;
}
export declare function string(): FieldDefinition<string>;
export declare function text(): FieldDefinition<string>;
export declare function email(): FieldDefinition<string>;
/** A finite number, including whole numbers. Use `integer()` when a fraction is meaningless. */
export declare function number(): FieldDefinition<number>;
export declare function integer(): FieldDefinition<number>;
export type SchemaJsonValue = string | number | boolean | null | SchemaJsonValue[] | {
    [key: string]: SchemaJsonValue;
};
/**
 * Structured data that stays with the record. Primitive values at bounded
 * object paths can be matched with Query.whereJsonPath on SQLite and D1.
 */
export declare function json(): FieldDefinition<SchemaJsonValue>;
/** A copy with sorted keys, so the same value has one stored form. */
export declare function stableJson(value: SchemaJsonValue): SchemaJsonValue;
export declare function boolean(): FieldDefinition<boolean>;
export declare function bool(): FieldDefinition<boolean>;
export declare class PointerFieldDefinition<TTarget extends string, TRequired extends boolean = true, THasDefault extends boolean = false> extends FieldDefinition<string, TRequired, THasDefault> {
    /** @internal Type-only relation target used by the client query builder. */
    readonly __target: TTarget;
    optional(): PointerFieldDefinition<TTarget, false, THasDefault>;
    default(value: string): PointerFieldDefinition<TTarget, TRequired, true>;
    min(value: number): PointerFieldDefinition<TTarget, TRequired, THasDefault>;
    max(value: number): PointerFieldDefinition<TTarget, TRequired, THasDefault>;
}
/**
 * Store the id of another Armadillo record while retaining its target in schema
 * metadata. Pointers remain JSON strings on the wire and can be queried like
 * any other field; adapters may use `target` to add joins or integrity checks.
 *
 * @deprecated Use {@link relation} instead. This alias keeps working.
 */
export declare function pointer<const TTarget extends string>(target: TTarget): PointerFieldDefinition<TTarget>;
/**
 * Point at a table key. `ref("users")` is an Armadillo user. `ref("files")` is an
 * uploaded file. `_User` and `_Team` stay valid targets.
 */
export declare function ref(target: "files"): FileFieldDefinition;
export declare function ref(target: "users"): PointerFieldDefinition<"_User">;
export declare function ref<const TTarget extends string>(target: TTarget): PointerFieldDefinition<TTarget>;
/** Store the id of another table's record. This is the canonical pointer spelling. */
export declare function relation<const TTarget extends string>(target: TTarget): PointerFieldDefinition<TTarget>;
export declare namespace relation {
    /** A pointer at an Armadillo user. */
    function user(): PointerFieldDefinition<"_User">;
    /** The one team pointer a table's permissions can prove. */
    function team(): PointerFieldDefinition<"_Team">;
}
/** Store an uploaded Armadillo file id with optional MIME and size constraints. */
export declare function file(): FileFieldDefinition;
/** What a reader sees for a tickets field. `sold` and the token stay off the record. */
export interface TicketRead {
    remaining: number | null;
}
/**
 * Inventory on one record. Omitted `supply` is unset, not unlimited.
 * The stored value is `{ supply, sold }`; readers see `{ remaining }`.
 */
export declare function tickets(options?: {
    supply?: number;
}): FieldDefinition<TicketRead, false, false>;
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
export declare function table<const TFields extends FieldMap>(fields: TFields, options?: TableOptions<TFields>): DefinedTable<TFields>;
declare const USER_EXTENSION_KIND = "armadillo.users";
export interface UserExtension<TFields extends FieldMap = FieldMap> {
    readonly kind: typeof USER_EXTENSION_KIND;
    readonly fields: TFields;
}
/** The only legal value of the `users` key in `defineSchema`. */
export declare const users: {
    extend<const TFields extends FieldMap>(fields: TFields): UserExtension<TFields>;
};
export declare function schema<const TTables extends Record<string, TableDefinition>>(tables: TTables): ExplainedSchema<TTables>;
/** `schema()` after the `users` key is lifted off into the profile IR. */
export declare function defineSchema<const TInput extends Record<string, TableDefinition | UserExtension>>(input: TInput): ExplainedSchema<Record<string, TableDefinition>>;
type FieldValue<TField> = TField extends FieldDefinition<infer TValue, boolean, boolean> ? TValue : never;
type ComputedKeys<TFields extends FieldMap> = {
    [TKey in keyof TFields]: TFields[TKey] extends {
        readonly __computed: true;
    } ? TKey : never;
}[keyof TFields];
type RequiredCreateKeys<TFields extends FieldMap> = Exclude<{
    [TKey in keyof TFields]: TFields[TKey] extends FieldDefinition<unknown, true, false> ? TKey : never;
}[keyof TFields], ComputedKeys<TFields>>;
type OptionalCreateKeys<TFields extends FieldMap> = Exclude<keyof TFields, RequiredCreateKeys<TFields> | ComputedKeys<TFields>>;
type OptionalRecordKeys<TFields extends FieldMap> = {
    [TKey in keyof TFields]: TFields[TKey] extends FieldDefinition<unknown, false, false> ? TKey : never;
}[keyof TFields];
type RequiredRecordKeys<TFields extends FieldMap> = Exclude<keyof TFields, OptionalRecordKeys<TFields> | ComputedKeys<TFields>>;
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
    [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition ? SchemaRecordData<TSchema["tables"][TName]> : never;
};
type InferredSchemaCreate<TSchema extends SchemaDefinition> = {
    [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition ? SchemaCreateData<TSchema["tables"][TName]> : never;
};
/** Type helpers merged onto the `schema()` function, similar to `z.infer`. */
export declare namespace schema {
    type infer<TSchema extends SchemaDefinition> = InferredSchema<TSchema>;
    type create<TSchema extends SchemaDefinition> = InferredSchemaCreate<TSchema>;
    type record<TSchema extends SchemaDefinition, TName extends keyof InferredSchema<TSchema>> = InferredSchema<TSchema>[TName];
}
export declare class SchemaValidationError extends Error {
    readonly fields: Record<string, string>;
    constructor(fields: Record<string, string>);
}
/** Stored tickets value. Accepts the object or the TEXT JSON column form. */
export declare function readStoredTickets(value: unknown): {
    supply: number | null;
    sold: number;
} | undefined;
/** `supply - sold` when supply is set. Unset supply is null, not unlimited. */
export declare function ticketRemaining(value: unknown): number | null;
/** Replace stored `{ supply, sold }` with `{ remaining }` on the way out. */
export declare function projectStoredTickets<T extends Record<string, unknown>>(definition: SchemaDefinition | undefined, collection: string, record: T): T;
/**
 * Keep `sold` when a patch sets `supply`. Supply below `sold` throws.
 * The record route calls this because a shallow merge would drop `sold`.
 */
export declare function mergeTicketSupply(definition: SchemaDefinition | undefined, collection: string, existing: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown>;
export declare function userProfileJsonPath(field: string): string;
export declare function userProfileUniqueIndexSql(field: string): string;
export declare function dropUserProfileUniqueIndexSql(field: string): string;
export declare function removedUserProfileFields(current: NormalizedSchema | undefined, desired: NormalizedSchema): string[];
export declare function uniqueUserProfileFields(definition: NormalizedSchema | undefined): string[];
export declare function encodeUserProfile(profile: Record<string, unknown>): string;
/**
 * Merge a profile write. Missing keys stay absent. A required file may be
 * absent on create because the user cannot own a file until they exist.
 */
export declare function assignUserProfile(fields: Record<string, NormalizedField>, current: Record<string, unknown>, assignments: Record<string, unknown>, mode: "create" | "patch"): Record<string, unknown>;
/** @internal */
export declare function validateSchemaData(definition: SchemaDefinition | undefined, tableName: string, data: Record<string, unknown>, partial: boolean): Record<string, unknown>;
/**
 * Validate a standalone field map without applying table-only restrictions to
 * its keys. Function contracts use this so common JSON names such as `id` are
 * valid while persisted records keep their reserved metadata fields.
 */
export declare function validateFieldMapData(fields: FieldMap, data: Record<string, unknown>, partial: boolean): Record<string, unknown>;
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
export declare function junkDrawer(options?: JunkDrawerOptions): DefinedTable<{
    readonly [field: string]: FieldDefinition<SchemaJsonValue, true, false>;
}>;
