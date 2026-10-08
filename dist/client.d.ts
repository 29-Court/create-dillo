import type { SchemaCreateData, SchemaDefinition, SchemaRecordData, TableDefinition } from "./schema.js";
import type { ArmadilloBackendDefinition, ArmadilloFunctionDefinition, JsonPrimitive, JsonValue } from "./backend.js";
import { QueryCache, type CacheConfig } from "./cache.js";
import type { DistanceUnit, GeoBoundingBox, GeoPoint } from "./geo.js";
import { RealtimeClient, type WebSocketFactory } from "./realtime-client.js";
import type { RealtimeEvent, RealtimeSubscription } from "./realtime.js";
export type { JsonPrimitive, JsonValue };
export type ObjectData = Record<string, JsonValue>;
type FunctionInput<TFunction> = TFunction extends ArmadilloFunctionDefinition<infer _TEnvironment, infer TInput, infer _TOutput> ? TInput : ObjectData;
type FunctionOutput<TFunction> = TFunction extends ArmadilloFunctionDefinition<infer _TEnvironment, infer _TInput, infer TOutput> ? Awaited<TOutput> : JsonValue;
/** A function map projected into the browser as ordinary typed async calls. */
export type ArmadilloFunctionClients<TFunctions> = TFunctions extends object ? {
    [TName in keyof TFunctions]: TName extends string ? {} extends FunctionInput<TFunctions[TName]> ? (data?: FunctionInput<TFunctions[TName]>, options?: AuthOperationOptions) => Promise<FunctionOutput<TFunctions[TName]>> : (data: FunctionInput<TFunctions[TName]>, options?: AuthOperationOptions) => Promise<FunctionOutput<TFunctions[TName]>> : never;
} : {};
type BackendSchema<TBackend extends ArmadilloBackendDefinition> = TBackend["schema"] extends SchemaDefinition ? TBackend["schema"] : undefined;
type BackendFunctions<TBackend extends ArmadilloBackendDefinition> = NonNullable<TBackend["functions"]>;
export type ArmadilloErrorCode = "BAD_REQUEST" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "STRUCTURE_DISCOVERY_DISABLED" | "CONFLICT" | "VALIDATION_ERROR" | "RATE_LIMITED" | "INTERNAL_ERROR";
export declare class ArmadilloError extends Error {
    readonly code: ArmadilloErrorCode;
    readonly status: number;
    readonly fields: Record<string, string> | undefined;
    readonly requestId: string | undefined;
    /** Actionable guidance from the backend. Describes the policy and what to do next. */
    readonly hint: string | undefined;
    constructor(message: string, options: {
        code: ArmadilloErrorCode;
        status: number;
        fields?: Record<string, string>;
        requestId?: string;
        hint?: string;
    });
}
export interface SessionStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface ArmadilloBaseOptions<TSchema extends SchemaDefinition | undefined> {
    /** Optional public registered-app identity. This is never a secret credential. */
    appId?: string;
    /** Optional data namespace for unconfigured/multi-tenant backends. */
    namespace?: string;
    /** Optional publishable deployment selector used for revocation and telemetry. */
    clientKey?: string;
    fetch?: Fetch;
    /** @deprecated Prefer `app.withAuth(token)` for an immutable bearer context. */
    credential?: string;
    /** Optional schema that exposes typed tables directly on `tables`. */
    schema?: TSchema;
    cache?: CacheConfig;
    /** Custom WebSocket constructor for Node, tests, and non-browser runtimes. */
    webSocket?: WebSocketFactory;
    /** Separate API Gateway WebSocket URL when realtime does not share the HTTP origin. */
    realtimeUrl?: string;
}
/** Public metadata may be embedded by a same-origin served client bundle. */
export interface ArmadilloPublicConfig {
    /** Dillo API origin. This is intentionally public. */
    url?: string;
    /** Optional registered-app identity. This is intentionally public. */
    appId?: string;
    /** The deployment stage, when the adapter knows it. */
    stage?: string;
    /** App-specific configuration deliberately marked public by the backend. */
    public?: Readonly<Record<string, JsonValue>>;
}
/**
 * Remote clients normally pass `url`. A same-origin browser may omit it: the
 * served client metadata wins, then the page origin is used as a clear fallback.
 */
export type ArmadilloOptions<TSchema extends SchemaDefinition | undefined = undefined> = ArmadilloBaseOptions<TSchema> & {
    url?: string;
    endpoint?: string;
};
export interface User {
    id: string;
    email: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface GroupInfo {
    id: string;
    name: string;
    slug: string;
    role: string;
    trusted: boolean;
    createdAt: string;
}
export interface GroupMember {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    joinedAt: string;
}
/** User-facing name for Dillo groups. Both APIs address the same records. */
export type TeamInfo = GroupInfo;
export type TeamMember = GroupMember;
export interface ArmadilloEvent<TData extends ObjectData = ObjectData> {
    id: string;
    groupId: string;
    type: string;
    actorId: string;
    actorName: string | null;
    data: TData;
    createdAt: string;
}
export interface SignUpInput {
    email: string;
    password: string;
    name?: string;
}
export interface LogInInput {
    email: string;
    password: string;
}
/** The authentication transport requested when establishing a session. */
export type LogInOptions = {
    mode: "token";
};
/** An explicitly requested, opaque, revocable bearer session. */
export interface TokenSession {
    user: User;
    token: string;
    expiresAt: string;
}
/** Auth may be supplied for exactly one request without changing a client. */
export interface AuthOperationOptions {
    auth?: {
        token: string;
    };
}
export interface ChangePasswordInput {
    currentPassword: string;
    newPassword: string;
}
export interface MagicLinkInput {
    email: string;
    redirectTo?: string;
}
export interface BootstrapInput extends SignUpInput {
    secret: string;
}
type AuthListener = (user: User | null) => void;
interface RequestOptions extends AuthOperationOptions {
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
    raw?: boolean;
}
export declare class ArmadilloClient<TSchema extends SchemaDefinition | undefined = undefined, TFunctions = undefined> {
    readonly url: string;
    readonly appId: string;
    readonly namespace: string;
    /** Public deployment metadata; it never contains runtime or API secrets. */
    readonly config: Readonly<ArmadilloPublicConfig>;
    readonly auth: AuthClient;
    readonly files: FilesClient;
    readonly groups: GroupsClient;
    readonly teams: GroupsClient;
    readonly events: EventsClient;
    readonly apiKeys: ApiKeysClient;
    readonly vouchers: VouchersClient;
    readonly tickets: TicketsClient;
    readonly collectors: CollectorsClient;
    readonly apps: AppsClient;
    readonly gdpr: GdprClient;
    readonly cache: QueryCache;
    readonly realtime: RealtimeClient;
    /** Typed function calls when the client is created from a backend type. */
    readonly functions: ArmadilloFunctionClients<TFunctions>;
    /** Typed table clients from a runtime schema or backend type. */
    readonly tables: TSchema extends SchemaDefinition ? SchemaTables<TSchema> : undefined;
    /**
     * Schema-typed table clients without passing a runtime schema to the browser.
     * Use `Armadillo<typeof schema>()` with a type-only schema import.
     */
    readonly models: TSchema extends SchemaDefinition ? SchemaTables<TSchema> : undefined;
    private readonly fetcher;
    private readonly clientKey;
    private readonly registeredAppId;
    private readonly requestNamespace;
    /** Immutable bearer context. Ambient browser auth is intentionally separate. */
    private readonly authToken;
    private readonly creationOptions;
    private readonly authListeners;
    private readonly cacheErrorListeners;
    constructor(options?: ArmadilloOptions<TSchema>);
    /**
     * Return a new client whose bearer credential is fixed for its lifetime.
     * This never changes this client, browser cookies, or any other context.
     */
    withAuth(token: string): ArmadilloClient<TSchema, TFunctions>;
    table<T extends ObjectData = ObjectData>(name: string): Table<T>;
    schema<TSchema extends SchemaDefinition>(definition: TSchema): SchemaTables<TSchema>;
    call<TResult = JsonValue>(name: string, data?: ObjectData, options?: AuthOperationOptions): Promise<TResult>;
    /** Submit to a typed collector with the least possible ceremony. */
    collect<TResult extends ObjectData = ObjectData>(collectorId: string, data: ObjectData): Promise<CollectorSubmission<TResult>>;
    /** @internal */
    subscribeAuth(listener: AuthListener): () => void;
    /** @internal */
    notifyAuth(user: User | null): void;
    /** Observe failed background cache revalidations and optimistic mutations. */
    onCacheError(listener: (error: Error) => void): () => void;
    /** @internal */
    notifyCacheError(error: unknown): void;
    /** @internal */
    request<T>(path: string, options?: RequestOptions): Promise<T>;
    /** @internal Fetch a presigned provider URL without Dillo auth headers. */
    fetchExternal(input: string, init: RequestInit): Promise<Response>;
}
export interface ArmadilloFactory {
    <TSchema extends SchemaDefinition | undefined = undefined>(options?: ArmadilloOptions<TSchema>): ArmadilloClient<TSchema>;
    new <TSchema extends SchemaDefinition | undefined = undefined>(options?: ArmadilloOptions<TSchema>): ArmadilloClient<TSchema>;
    /** Explicit alias when a framework prefers a named factory. */
    client<TSchema extends SchemaDefinition | undefined = undefined>(options?: ArmadilloOptions<TSchema>): ArmadilloClient<TSchema>;
    /**
     * Create a fully typed client from a backend type without importing backend
     * runtime code into the browser.
     *
     * `Armadillo.client<typeof backend>({ url })` exposes
     * `client.functions.<name>(input)` with the function's input and output.
     */
    client<TBackend extends ArmadilloBackendDefinition>(options?: ArmadilloOptions<BackendSchema<TBackend>>): ArmadilloClient<BackendSchema<TBackend>, BackendFunctions<TBackend>>;
}
/** The framework-neutral Dillo browser client. */
export declare const Armadillo: ArmadilloFactory;
/** @deprecated Prefer the product-named `Armadillo()` factory. */
export declare const armadillo: ArmadilloFactory;
type AnyArmadillo = ArmadilloClient<SchemaDefinition | undefined, any>;
export declare class GroupsClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    list(): Promise<GroupInfo[]>;
    create(input: {
        name: string;
        slug: string;
    }): Promise<GroupInfo>;
    createTrusted(input: {
        name: string;
        slug: string;
    }, adminKey: string): Promise<GroupInfo>;
    members(groupId: string): Promise<GroupMember[]>;
    addMember(groupId: string, input: {
        email: string;
        role: string;
    }): Promise<GroupMember>;
    removeMember(groupId: string, userId: string): Promise<void>;
    /**
     * Hand team ownership to a current member. Only the owner may call it;
     * the previous owner steps down to admin. Both updates commit atomically.
     */
    transferOwnership(groupId: string, input: {
        email: string;
    }): Promise<{
        member: GroupMember;
        previousOwner: GroupMember;
    }>;
}
export declare class EventsClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    list<TData extends ObjectData = ObjectData>(options?: {
        after?: string;
        limit?: number;
    }): Promise<ArmadilloEvent<TData>[]>;
}
export declare class AuthClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    signUp(input: SignUpInput): Promise<User>;
    signUp(input: SignUpInput, options: LogInOptions): Promise<TokenSession>;
    logIn(input: LogInInput): Promise<User>;
    logIn(input: LogInInput, options: LogInOptions): Promise<TokenSession>;
    private acceptSession;
    requestMagicLink(input: MagicLinkInput): Promise<{
        queued: true;
        debugToken?: string;
    }>;
    verifyMagicLink(token: string): Promise<User>;
    verifyMagicLink(token: string, options: LogInOptions): Promise<TokenSession>;
    bootstrap(input: BootstrapInput): Promise<User>;
    bootstrap(input: BootstrapInput, options: LogInOptions): Promise<TokenSession>;
    logOut(): Promise<void>;
    changePassword(input: ChangePasswordInput): Promise<void>;
    currentUser(): Promise<User | null>;
    onChange(listener: AuthListener): () => void;
}
interface RawObject extends ObjectData {
    id: string;
    ownerId: string;
    createdAt: string;
    updatedAt: string;
}
export type ArmadilloObject<T extends ObjectData = ObjectData, TPath extends string = string> = T & {
    readonly id: string;
    readonly ownerId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly files: RecordFilesClient;
    update(changes: Partial<T>, options?: {
        optimistic?: boolean;
    }): Promise<ArmadilloObject<T, TPath>>;
    delete(): Promise<void>;
    /** Walk forward refs on this record. An id already in the chain stays the id string. */
    expand(path: TPath): Promise<ObjectData | string | null>;
    toJSON(): T & {
        id: string;
        ownerId: string;
        createdAt: string;
        updatedAt: string;
    };
};
export declare class Table<T extends ObjectData = ObjectData, TCreate extends ObjectData = T, TRelations extends Record<string, ObjectData> = Record<string, ObjectData>, TPath extends string = string> {
    private readonly app;
    private readonly fieldNames?;
    readonly name: string;
    /** Inventory tokens for this table's tickets field. Not `app.tickets`. */
    readonly tickets: {
        issue(recordId: string, options?: AuthOperationOptions): Promise<{
            token: string;
        }>;
        consume(token: string, options?: AuthOperationOptions): Promise<{
            ok: true;
            remaining: number | null;
            soldOut: boolean;
            idempotent?: true;
        }>;
    };
    constructor(app: AnyArmadillo, name: string, fieldNames?: ReadonlySet<string> | undefined);
    create(data: TCreate, options?: AuthOperationOptions): Promise<ArmadilloObject<T, TPath>>;
    createMany(items: TCreate[], options?: AuthOperationOptions): Promise<ArmadilloObject<T, TPath>[]>;
    get(id: string, options?: AuthOperationOptions): Promise<ArmadilloObject<T, TPath>>;
    update(id: string, changes: Partial<T>, options?: AuthOperationOptions): Promise<ArmadilloObject<T, TPath>>;
    delete(id: string, options?: AuthOperationOptions): Promise<void>;
    query(): Query<T, TCreate, T, TRelations, TPath>;
    /**
     * Sugar for `query().where(...).include(...).limit(...).find()`.
     * `where` keys are fields on this table only.
     */
    find(options?: {
        where?: Partial<T>;
        include?: IncludeTree;
        limit?: number;
    }): Promise<ArmadilloObject<T, TPath>[]>;
    subscribe(options: {
        where?: Partial<T>;
        onChange(event: RealtimeEvent<ArmadilloObject<T, TPath>>): void;
    }): RealtimeSubscription<ArmadilloObject<T, TPath>>;
    files(id: string): RecordFilesClient;
    /** @internal */
    hydrate(raw: RawObject): ArmadilloObject<T, TPath>;
    /** @internal */
    expandRecord(id: string, path: string): Promise<ObjectData | string | null>;
    /** @internal */
    rejectForeignWhere(field: string): void;
    /** @internal */
    invalidateQueries(): void;
    /** @internal */
    notifyCacheError(error: unknown): void;
}
type PointerKeysOf<TTable extends TableDefinition> = {
    [TKey in keyof TTable["fields"]]: TTable["fields"][TKey] extends {
        readonly __target: string;
    } ? TKey extends string ? TKey : never : never;
}[keyof TTable["fields"]];
type TwoHopPaths<TSchema extends SchemaDefinition, TTable extends TableDefinition> = {
    [TKey in keyof TTable["fields"] & string]: TTable["fields"][TKey] extends {
        readonly __target: infer TTarget extends string;
    } ? TTarget extends keyof TSchema["tables"] ? TSchema["tables"][TTarget] extends TableDefinition ? PointerKeysOf<TSchema["tables"][TTarget]> extends infer TNext ? TNext extends string ? `${TKey}.${TNext}` : never : never : never : never : never;
}[keyof TTable["fields"] & string];
/** One- and two-segment forward ref paths. An unknown segment is not in the union. */
export type ExpandPath<TSchema extends SchemaDefinition, TTable extends TableDefinition> = PointerKeysOf<TTable> | TwoHopPaths<TSchema, TTable>;
export type SchemaTables<TSchema extends SchemaDefinition> = {
    [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition ? Table<SchemaRecordData<TSchema["tables"][TName]>, SchemaCreateData<TSchema["tables"][TName]>, SchemaRelationMap<TSchema, TSchema["tables"][TName]>, ExpandPath<TSchema, TSchema["tables"][TName]>> : never;
};
type RelationValue<TSchema extends SchemaDefinition, TField> = TField extends {
    readonly __target: infer TTarget extends string;
} ? TTarget extends keyof TSchema["tables"] ? TSchema["tables"][TTarget] extends TableDefinition ? SchemaRecordData<TSchema["tables"][TTarget]> : ObjectData : TTarget extends "_User" ? ObjectData & Pick<User, "id" | "name"> : TTarget extends "_Team" ? ObjectData & Pick<TeamInfo, "id" | "name" | "slug"> : ObjectData : never;
type SchemaRelationMap<TSchema extends SchemaDefinition, TTable extends TableDefinition> = {
    [TKey in keyof TTable["fields"] as TTable["fields"][TKey] extends {
        readonly __target: string;
    } ? TKey : never]: RelationValue<TSchema, TTable["fields"][TKey]>;
};
/**
 * An include takes no options. `limit`, `orderBy`, and `descending` were typed
 * here and dropped by the server, which returned up to 100 rows per parent in id
 * order; they are gone from the type, refused here for JavaScript callers, and
 * 400 on the wire. Query the related table on its own to limit or order it.
 */
export interface ExpandOptions {
    expand?: string | readonly string[];
}
export type IncludeTree = string | readonly string[] | {
    readonly [key: string]: true | {
        readonly include: IncludeTree;
    };
};
type ExpandedResult<T extends ObjectData, TRelations extends Record<string, ObjectData>, K extends keyof T & keyof TRelations & string> = Omit<T, K> & {
    [P in K]: (TRelations[P] & {
        id: string;
        ownerId?: string;
        createdAt?: string;
        updatedAt?: string;
    }) | null;
};
export declare class Query<T extends ObjectData = ObjectData, TCreate extends ObjectData = T, TResult extends ObjectData = T, TRelations extends Record<string, ObjectData> = Record<string, ObjectData>, TPath extends string = string> {
    private readonly app;
    private readonly table;
    private readonly filters;
    private readonly ordering;
    private maximum;
    private offset;
    private limitTouched;
    private readonly expands;
    private readonly nearConstraints;
    private readonly boundingBoxes;
    private spatialOrder;
    private includeDistance;
    constructor(app: AnyArmadillo, table: Table<T, TCreate, TRelations, TPath>);
    where(fields: Partial<T>): this;
    where<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this;
    equalTo<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this;
    /** Match a primitive at a bounded object path within a declared JSON field. */
    whereJsonPath(field: keyof T & string, path: string, value: JsonPrimitive): this;
    notEqualTo<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this;
    lessThan(field: keyof T & string, value: JsonPrimitive): this;
    lessThanOrEqualTo(field: keyof T & string, value: JsonPrimitive): this;
    greaterThan(field: keyof T & string, value: JsonPrimitive): this;
    greaterThanOrEqualTo(field: keyof T & string, value: JsonPrimitive): this;
    containedIn(field: keyof T & string, values: JsonPrimitive[]): this;
    contains(field: keyof T & string, value: string): this;
    orderBy(field: (keyof T & string) | "createdAt" | "updatedAt", direction?: "asc" | "desc" | {
        descending?: boolean;
        nearest?: GeoPoint;
        farthest?: GeoPoint;
    }): this;
    ascending(field: (keyof T & string) | "createdAt" | "updatedAt"): this;
    descending(field: (keyof T & string) | "createdAt" | "updatedAt"): this;
    limit(maximum: number): this;
    skip(offset: number): this;
    expand<K extends keyof TResult & keyof TRelations & string>(field: K, options?: ExpandOptions): Query<T, TCreate, ExpandedResult<TResult, TRelations, K>, TRelations, TPath>;
    /** Tree include. Depth 4 throws before the request. Sends the same expands payload as expand(). */
    include(spec: IncludeTree): this;
    near(field: keyof T & string, options: {
        center: GeoPoint;
        radius: number;
        unit?: DistanceUnit;
    }): this;
    withinBoundingBox(field: keyof T & string, bounds: GeoBoundingBox): this;
    select(options: {
        includeDistance: keyof T & string;
    }): Query<T, TCreate, TResult & {
        _distance: number;
    }, TRelations, TPath>;
    find(options?: AuthOperationOptions): Promise<ArmadilloObject<TResult, TPath>[]>;
    /**
     * Page an untouched find() with skip until a short page. Page size 100 is internal.
     *
     * The assembled result is cached under the untouched-query key, because that
     * is the shape `table("X").query().find()` — the most common call there is —
     * takes. Without this, `cache-first` never served a hit for it and every read
     * went to the network, which is the opposite of what the strategy promises.
     */
    private findEveryPage;
    private findEveryPageInto;
    private fetchAndCache;
    first(options?: AuthOperationOptions): Promise<ArmadilloObject<TResult, TPath> | null>;
    count(options?: AuthOperationOptions): Promise<number>;
    private addFilter;
    private payload;
}
export interface FileInfo {
    id: string;
    name: string;
    contentType: string;
    size: number;
    etag: string;
    createdAt: string;
}
export type ArmadilloFile = FileInfo & {
    download(): Promise<Blob>;
    url(): Promise<string>;
    delete(): Promise<void>;
};
export interface UploadOptions extends AuthOperationOptions {
    name?: string;
    contentType?: string;
    mode?: "auto" | "proxy" | "direct" | "multipart";
}
export declare class FilesClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    upload(blob: Blob, options?: UploadOptions): Promise<ArmadilloFile>;
    uploadDirect(blob: Blob, options?: UploadOptions): Promise<ArmadilloFile>;
    uploadMultipart(blob: Blob, options?: UploadOptions): Promise<ArmadilloFile>;
    get(id: string, options?: AuthOperationOptions): Promise<ArmadilloFile>;
    list(options?: AuthOperationOptions): Promise<ArmadilloFile[]>;
    listPage(options?: {
        limit?: number;
        cursor?: string;
    } & AuthOperationOptions): Promise<{
        files: ArmadilloFile[];
        nextCursor: string | null;
    }>;
    download(id: string, options?: AuthOperationOptions): Promise<Blob>;
    url(id: string, options?: AuthOperationOptions): Promise<string>;
    delete(id: string, options?: AuthOperationOptions): Promise<void>;
}
export declare class RecordFilesClient {
    private readonly app;
    private readonly table;
    private readonly objectId;
    constructor(app: AnyArmadillo, table: string, objectId: string);
    private path;
    list(): Promise<ArmadilloFile[]>;
    attach(file: FileInfo | string, position?: number): Promise<ArmadilloFile>;
    upload(blob: Blob, options?: UploadOptions): Promise<ArmadilloFile>;
    detach(file: FileInfo | string): Promise<void>;
}
export interface ApiKeyInfo {
    id: string;
    name: string;
    description: string | null;
    prefix: string;
    scopes: string[];
    rotatedFrom: string | null;
    graceExpiresAt: string | null;
    createdAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
}
export interface ApiKeyAuditEvent {
    id: string;
    keyId: string;
    actorId: string;
    type: "created" | "rotated" | "revoked";
    details: ObjectData;
    createdAt: string;
}
export declare class ApiKeysClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    list(): Promise<ApiKeyInfo[]>;
    create(input: {
        name: string;
        description?: string;
        scopes: string[];
        expiresAt?: string;
    }): Promise<{
        apiKey: ApiKeyInfo;
        secret: string;
    }>;
    get(id: string): Promise<ApiKeyInfo>;
    update(id: string, input: {
        name?: string;
        description?: string | null;
    }): Promise<ApiKeyInfo>;
    rotate(id: string, options?: {
        gracePeriodSeconds?: number;
    }): Promise<{
        apiKey: ApiKeyInfo;
        secret: string;
    }>;
    audit(id: string): Promise<ApiKeyAuditEvent[]>;
    revoke(id: string): Promise<void>;
}
export type VoucherStatus = "active" | "depleted" | "expired";
export interface VoucherInfo {
    id: string;
    name: string;
    codePrefix: string;
    capacity: number;
    remaining: number;
    consumed: number;
    status: VoucherStatus;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export declare class VouchersClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    list(): Promise<VoucherInfo[]>;
    get(id: string): Promise<VoucherInfo>;
    create(input: {
        name: string;
        capacity?: number;
        expiresAt?: string;
    }): Promise<{
        voucher: VoucherInfo;
        code: string;
    }>;
    consume(code: string, idempotencyKey: string): Promise<{
        consumed: true;
        idempotent: boolean;
        voucher: VoucherInfo;
    }>;
    restock(id: string, amount?: number): Promise<VoucherInfo>;
    expire(id: string): Promise<void>;
}
export type TicketStatus = "active" | "consumed" | "expired";
export interface TicketInfo {
    id: string;
    label: string;
    teamId: string;
    holderId: string | null;
    eventId: string | null;
    codePrefix: string;
    metadata: ObjectData;
    status: TicketStatus;
    expiresAt: string | null;
    consumedAt: string | null;
    consumedBy: string | null;
    createdAt: string;
    updatedAt: string;
}
/** A looked-up ticket keeps its opaque code private and exposes atomic consume(). */
export declare class Ticket {
    private readonly client;
    private readonly code;
    private value;
    constructor(client: TicketsClient, code: string, value: TicketInfo);
    get id(): string;
    get label(): string;
    get status(): TicketStatus;
    get consumedAt(): string | null;
    get consumedBy(): string | null;
    toJSON(): TicketInfo;
    consume(idempotencyKey?: `${string}-${string}-${string}-${string}-${string}`): Promise<{
        consumed: true;
        idempotent: boolean;
        ticket: Ticket;
    }>;
}
export declare class TicketsClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    list(): Promise<TicketInfo[]>;
    get(id: string): Promise<TicketInfo>;
    issue(input: {
        label: string;
        holderId?: string;
        eventId?: string;
        metadata?: ObjectData;
        expiresAt?: string;
    }): Promise<{
        ticket: TicketInfo;
        code: string;
    }>;
    lookup(code: string): Promise<Ticket>;
    /** @internal Prefer lookup(code).consume() in application UI. */
    consume(code: string, idempotencyKey: string): Promise<{
        consumed: true;
        idempotent: boolean;
        ticket: TicketInfo;
    }>;
}
export interface CollectorSubmission<TData extends ObjectData = ObjectData> {
    id: string;
    collectorId: string;
    userId: string | null;
    teamId: string;
    project: string | null;
    data: TData;
    createdAt: string;
    expiresAt: string;
    /** Present when the collector writes its submission into an application model. */
    record?: {
        id: string;
        collection: string;
    };
}
export declare class CollectorClient<TData extends ObjectData = ObjectData> {
    private readonly app;
    readonly id: string;
    constructor(app: AnyArmadillo, id: string);
    submit(data: ObjectData): Promise<CollectorSubmission<TData>>;
    submissions(): Promise<CollectorSubmission<TData>[]>;
}
export declare class CollectorsClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    get<TData extends ObjectData = ObjectData>(id: string): CollectorClient<TData>;
}
export interface RegisteredAppInfo {
    id: string;
    name: string;
    mode: "managed" | "external" | "public";
    auth: "required" | "optional" | "none";
    origins: string[];
    capabilities: Record<string, string[]>;
    enabled: boolean;
    clientKeyConfigured: boolean;
    /** Deliberately public registered-app configuration, never a secret. */
    public?: Record<string, JsonValue>;
    provenance?: {
        version?: string;
        bundleHash?: string;
        deploymentId?: string;
    };
}
export declare class AppsClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    current(): Promise<RegisteredAppInfo>;
    list(): Promise<RegisteredAppInfo[]>;
}
export interface GdprConsent {
    id: string;
    purpose: string;
    granted: boolean;
    metadata?: Record<string, JsonValue> | null;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string | null;
}
export interface GdprInfo {
    dpoEmail?: string | null;
    privacyPolicyUrl?: string | null;
    retentionDays?: number | null;
    purposes: string[];
    requireExplicitConsent: boolean;
}
export interface GdprExportBundle {
    exportId: string;
    user: User;
    consents: GdprConsent[];
    memberships: Array<{
        groupId: string;
        groupName: string;
        groupSlug: string;
        role: string;
        trusted: boolean;
    }>;
    sessions: Array<{
        id: string;
        createdAt: string;
        expiresAt: string;
    }>;
    apiKeys: Array<{
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        createdAt: string;
    }>;
    objects: Array<{
        collection: string;
        id: string;
        data: ObjectData;
        createdAt: string;
        updatedAt: string;
    }>;
    files: Array<{
        id: string;
        name: string;
        contentType: string;
        size: number;
        createdAt: string;
    }>;
    collectorSubmissions: Array<{
        id: string;
        collectorId: string;
        data: ObjectData;
        createdAt: string;
        expiresAt: string;
    }>;
    tickets: Array<{
        id: string;
        label: string;
        metadata: ObjectData;
        createdAt: string;
    }>;
    generatedAt: string;
    dpoEmail?: string | null;
    privacyPolicyUrl?: string | null;
}
export type GdprErasureResult = {
    erased: true;
    strategy: "delete";
    details: {
        deletedObjects: number;
        deletedFiles: number;
        deletedCollectorSubs: number;
        tombstoneEmail: string;
    };
} | {
    erased: true;
    strategy: "anonymize";
    details: {
        anonymized: true;
        tombstoneEmail: string;
    };
};
export declare class GdprClient {
    private readonly app;
    constructor(app: AnyArmadillo);
    info(): Promise<GdprInfo>;
    consents(): Promise<GdprConsent[]>;
    consent(input: {
        purpose: string;
        granted: boolean;
        metadata?: ObjectData;
        expiresAt?: string;
    }): Promise<GdprConsent>;
    export(): Promise<GdprExportBundle>;
    rectify(input: {
        name?: string | null;
        email?: string;
    }): Promise<User>;
    restrict(input: {
        restricted: boolean;
        reason?: string;
    }): Promise<{
        restricted: boolean;
    }>;
    erase(input: {
        confirm: string;
        reason?: string;
        strategy?: "delete" | "anonymize";
    }): Promise<GdprErasureResult>;
    erasureLog(): Promise<Array<{
        id: string;
        targetUserId: string;
        actorUserId: string;
        strategy: string;
        reason: string | null;
        createdAt: string;
        completedAt: string | null;
    }>>;
}
