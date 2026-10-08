import { HTTP_API_PREFIX } from "./versions.js";
import type {
  SchemaCreateData,
  SchemaDefinition,
  SchemaRecordData,
  TableDefinition,
} from "./schema.js";
import type {
  ArmadilloBackendDefinition,
  ArmadilloFunctionDefinition,
  JsonPrimitive,
  JsonValue,
} from "./backend.js";
import { QueryCache, queryCacheKey, type CacheConfig } from "./cache.js";
import type { DistanceUnit, GeoBoundingBox, GeoPoint } from "./geo.js";
import { assertGeoPoint, distanceInMeters } from "./geo.js";
import { RealtimeClient, type WebSocketFactory } from "./realtime-client.js";
import type { RealtimeEvent, RealtimeSubscription } from "./realtime.js";

export type { JsonPrimitive, JsonValue };
export type ObjectData = Record<string, JsonValue>;

type FunctionInput<TFunction> = TFunction extends ArmadilloFunctionDefinition<
  infer _TEnvironment,
  infer TInput,
  infer _TOutput
> ? TInput : ObjectData;

type FunctionOutput<TFunction> = TFunction extends ArmadilloFunctionDefinition<
  infer _TEnvironment,
  infer _TInput,
  infer TOutput
> ? Awaited<TOutput> : JsonValue;

/** A function map projected into the browser as ordinary typed async calls. */
export type ArmadilloFunctionClients<TFunctions> = TFunctions extends object ? {
  [TName in keyof TFunctions]: TName extends string
    ? {} extends FunctionInput<TFunctions[TName]>
      ? (data?: FunctionInput<TFunctions[TName]>, options?: AuthOperationOptions) => Promise<FunctionOutput<TFunctions[TName]>>
      : (data: FunctionInput<TFunctions[TName]>, options?: AuthOperationOptions) => Promise<FunctionOutput<TFunctions[TName]>>
    : never;
} : {};

type BackendSchema<TBackend extends ArmadilloBackendDefinition> = TBackend["schema"] extends SchemaDefinition
  ? TBackend["schema"]
  : undefined;

type BackendFunctions<TBackend extends ArmadilloBackendDefinition> = NonNullable<TBackend["functions"]>;

export type ArmadilloErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STRUCTURE_DISCOVERY_DISABLED"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class ArmadilloError extends Error {
  readonly code: ArmadilloErrorCode;
  readonly status: number;
  readonly fields: Record<string, string> | undefined;
  readonly requestId: string | undefined;
  /** Actionable guidance from the backend. Describes the policy and what to do next. */
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: {
      code: ArmadilloErrorCode;
      status: number;
      fields?: Record<string, string>;
      requestId?: string;
      hint?: string;
    },
  ) {
    super(message);
    this.name = "ArmadilloError";
    this.code = options.code;
    this.status = options.status;
    this.fields = options.fields;
    this.requestId = options.requestId;
    this.hint = options.hint;
  }
}

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
export type ArmadilloOptions<TSchema extends SchemaDefinition | undefined = undefined> =
  ArmadilloBaseOptions<TSchema> & {
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
export type LogInOptions = { mode: "token" };

/** An explicitly requested, opaque, revocable bearer session. */
export interface TokenSession {
  user: User;
  token: string;
  expiresAt: string;
}

/** Auth may be supplied for exactly one request without changing a client. */
export interface AuthOperationOptions {
  auth?: { token: string };
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

interface ErrorEnvelope {
  error?: {
    code?: ArmadilloErrorCode;
    message?: string;
    fields?: Record<string, string>;
    hint?: string;
    requestId?: string;
  };
}

interface RequestOptions extends AuthOperationOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  raw?: boolean;
}

interface SessionEnvelope {
  user: User;
  token?: string;
  expiresAt?: string;
}

const DEFAULT_APP_ID = "default";

function publicConfig(): ArmadilloPublicConfig | undefined {
  const value = (globalThis as typeof globalThis & {
    __ARMADILLO__?: ArmadilloPublicConfig;
  }).__ARMADILLO__;
  return value && typeof value === "object" ? value : undefined;
}

function sameOrigin(): string | undefined {
  if (typeof location === "undefined" || !location.origin || location.origin === "null") return undefined;
  return location.origin;
}

function normalizeUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, "");
  if (!normalized) throw new TypeError("Dillo requires a backend URL.");
  return normalized;
}

function isBody(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}

export class ArmadilloClient<
  TSchema extends SchemaDefinition | undefined = undefined,
  TFunctions = undefined,
> {
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

  private readonly fetcher: Fetch;
  private readonly clientKey: string | undefined;
  private readonly registeredAppId: string | undefined;
  private readonly requestNamespace: string | undefined;
  /** Immutable bearer context. Ambient browser auth is intentionally separate. */
  private readonly authToken: string | undefined;
  private readonly creationOptions: ArmadilloOptions<TSchema>;
  private readonly authListeners = new Set<AuthListener>();
  private readonly cacheErrorListeners = new Set<(error: Error) => void>();

  constructor(options: ArmadilloOptions<TSchema> = {}) {
    const candidate = publicConfig();
    const explicitUrl = options.url ?? options.endpoint;
    const embeddedUrl = candidate?.url ?? sameOrigin();
    const embedded = !explicitUrl || (embeddedUrl && normalizeUrl(explicitUrl) === normalizeUrl(embeddedUrl)) ? candidate : undefined;
    const endpoint = options.url ?? options.endpoint ?? embedded?.url ?? sameOrigin();
    if (!endpoint) throw new TypeError("Dillo needs a url or endpoint.");
    this.url = normalizeUrl(endpoint);
    this.registeredAppId = options.appId?.trim() || undefined;
    this.requestNamespace = options.namespace?.trim() || embedded?.appId?.trim() || this.registeredAppId;
    this.appId = this.registeredAppId ?? embedded?.appId?.trim() ?? DEFAULT_APP_ID;
    this.namespace = this.requestNamespace ?? DEFAULT_APP_ID;
    this.config = Object.freeze({
      url: this.url,
      ...(this.registeredAppId || this.requestNamespace ? { appId: this.registeredAppId ?? this.requestNamespace! } : {}),
      ...(embedded?.stage ? { stage: embedded.stage } : {}),
      ...(embedded?.public ? { public: Object.freeze({ ...embedded.public }) } : {}),
    });
    this.clientKey = options.clientKey?.trim() || undefined;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.authToken = options.credential?.trim() || undefined;
    const { credential: _credential, appId: _appId, endpoint: _endpoint, ...cloneOptions } = options;
    void _credential;
    void _appId;
    void _endpoint;
    this.creationOptions = {
      ...cloneOptions,
      url: this.url,
      ...(this.registeredAppId ? { appId: this.registeredAppId } : {}),
      ...(this.requestNamespace ? { namespace: this.requestNamespace } : {}),
    };
    this.cache = new QueryCache(options.cache ?? {});
    this.auth = new AuthClient(this);
    this.files = new FilesClient(this);
    this.groups = new GroupsClient(this);
    this.teams = this.groups;
    this.events = new EventsClient(this);
    this.apiKeys = new ApiKeysClient(this);
    this.vouchers = new VouchersClient(this);
    this.tickets = new TicketsClient(this);
    this.collectors = new CollectorsClient(this);
    this.apps = new AppsClient(this);
    this.gdpr = new GdprClient(this);
    this.functions = new Proxy({}, {
      get: (_target, name) => typeof name === "string"
        ? (data: ObjectData = {}, requestOptions: AuthOperationOptions = {}) => this.call(name, data, requestOptions)
        : undefined,
    }) as ArmadilloFunctionClients<TFunctions>;
    this.realtime = new RealtimeClient({
      url: this.url,
      ...(this.registeredAppId ? { clientAppId: this.registeredAppId } : {}),
      ...(this.requestNamespace ? { namespace: this.requestNamespace } : {}),
      ...(options.realtimeUrl ? { realtimeUrl: options.realtimeUrl } : {}),
      credential: () => this.authToken ?? null,
      ...(this.clientKey ? { clientKey: this.clientKey } : {}),
      ...(options.webSocket ? { webSocket: options.webSocket } : {}),
    });
    this.tables = (options.schema ? this.schema(options.schema) : new Proxy({}, {
      get: (_target, name) => typeof name === "string" ? this.table(name) : undefined,
    })) as TSchema extends SchemaDefinition ? SchemaTables<TSchema> : undefined;
    this.models = this.tables;
  }

  /**
   * Return a new client whose bearer credential is fixed for its lifetime.
   * This never changes this client, browser cookies, or any other context.
   */
  withAuth(token: string): ArmadilloClient<TSchema, TFunctions> {
    const credential = token.trim();
    if (!credential) throw new TypeError("withAuth(token) requires a bearer token.");
    return new ArmadilloClient<TSchema, TFunctions>({ ...this.creationOptions, credential });
  }

  table<T extends ObjectData = ObjectData>(name: string): Table<T> {
    return new Table<T>(this, name);
  }

  schema<TSchema extends SchemaDefinition>(definition: TSchema): SchemaTables<TSchema> {
    const result: Record<string, Table<ObjectData>> = {};
    for (const name of Object.keys(definition.tables)) {
      const fields = definition.tables[name]?.fields;
      result[name] = new Table(this, name, new Set(fields ? Object.keys(fields) : []));
    }
    return result as SchemaTables<TSchema>;
  }

  async call<TResult = JsonValue>(
    name: string,
    data: ObjectData = {},
    options: AuthOperationOptions = {},
  ): Promise<TResult> {
    const result = await this.request<{ result: TResult }>(
      `${HTTP_API_PREFIX}/functions/${encodeURIComponent(name)}`,
      { method: "POST", body: { data }, ...options },
    );
    return result.result;
  }

  /** Submit to a typed collector with the least possible ceremony. */
  async collect<TResult extends ObjectData = ObjectData>(
    collectorId: string,
    data: ObjectData,
  ): Promise<CollectorSubmission<TResult>> {
    return this.collectors.get<TResult>(collectorId).submit(data);
  }

  /** @internal */
  subscribeAuth(listener: AuthListener): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  /** @internal */
  notifyAuth(user: User | null): void {
    this.cache.invalidateAll();
    for (const listener of this.authListeners) listener(user);
  }

  /** Observe failed background cache revalidations and optimistic mutations. */
  onCacheError(listener: (error: Error) => void): () => void {
    this.cacheErrorListeners.add(listener);
    return () => this.cacheErrorListeners.delete(listener);
  }

  /** @internal */
  notifyCacheError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.cacheErrorListeners) listener(normalized);
  }

  /** @internal */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (this.requestNamespace) headers.set("x-armadillo-app-id", this.requestNamespace);
    if (this.registeredAppId) headers.set("x-armadillo-client-app-id", this.registeredAppId);
    if (this.clientKey) headers.set("x-armadillo-client-key", this.clientKey);

    // Auth is resolved only for this request: per-operation > context > cookie.
    const token = options.auth?.token ?? this.authToken;
    if (token) headers.set("authorization", `Bearer ${token}`);

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (isBody(options.body)) {
        body = options.body;
      } else {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
      }
    }

    const response = await this.fetcher(`${this.url}${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      credentials: "include",
      ...(body === undefined ? {} : { body }),
    });

    if (!response.ok) {
      let envelope: ErrorEnvelope = {};
      try {
        envelope = (await response.json()) as ErrorEnvelope;
      } catch {
        // A proxy can replace the JSON error. The status still remains useful.
      }
      const error = envelope.error;
      const requestId = error?.requestId ?? response.headers.get("x-request-id") ?? undefined;
      throw new ArmadilloError(error?.message ?? `Request failed (${response.status}).`, {
        code: error?.code ?? "INTERNAL_ERROR",
        status: response.status,
        ...(error?.fields ? { fields: error.fields } : {}),
        ...(error?.hint ? { hint: error.hint } : {}),
        ...(requestId ? { requestId } : {}),
      });
    }

    if (options.raw) return response as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** @internal Fetch a presigned provider URL without Dillo auth headers. */
  async fetchExternal(input: string, init: RequestInit): Promise<Response> {
    return this.fetcher(input, init);
  }
}

export interface ArmadilloFactory {
  <TSchema extends SchemaDefinition | undefined = undefined>(
    options?: ArmadilloOptions<TSchema>,
  ): ArmadilloClient<TSchema>;
  new <TSchema extends SchemaDefinition | undefined = undefined>(
    options?: ArmadilloOptions<TSchema>,
  ): ArmadilloClient<TSchema>;
  /** Explicit alias when a framework prefers a named factory. */
  client<TSchema extends SchemaDefinition | undefined = undefined>(
    options?: ArmadilloOptions<TSchema>,
  ): ArmadilloClient<TSchema>;
  /**
   * Create a fully typed client from a backend type without importing backend
   * runtime code into the browser.
   *
   * `Armadillo.client<typeof backend>({ url })` exposes
   * `client.functions.<name>(input)` with the function's input and output.
   */
  client<TBackend extends ArmadilloBackendDefinition>(
    options?: ArmadilloOptions<BackendSchema<TBackend>>,
  ): ArmadilloClient<BackendSchema<TBackend>, BackendFunctions<TBackend>>;
}

function createArmadillo<TSchema extends SchemaDefinition | undefined = undefined>(
  options?: ArmadilloOptions<TSchema>,
): ArmadilloClient<TSchema> {
  return new ArmadilloClient(options);
}

// Keep `new Armadillo({ url })` source-compatible while making the natural
// `Armadillo({ url })` form work in browser code and plain script tags.
createArmadillo.prototype = ArmadilloClient.prototype;
createArmadillo.client = createArmadillo;

/** The framework-neutral Dillo browser client. */
export const Armadillo = createArmadillo as unknown as ArmadilloFactory;

/** @deprecated Prefer the product-named `Armadillo()` factory. */
export const armadillo = Armadillo;

// Internal resource clients do not inspect the typed function map.
// `any` prevents that map's contravariant call arguments from making the
// enclosing client invariant for unrelated resource clients.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArmadillo = ArmadilloClient<SchemaDefinition | undefined, any>;

export class GroupsClient {
  constructor(private readonly app: AnyArmadillo) {}

  async list(): Promise<GroupInfo[]> {
    return (await this.app.request<{ groups: GroupInfo[] }>(`${HTTP_API_PREFIX}/groups`)).groups;
  }

  async create(input: { name: string; slug: string }): Promise<GroupInfo> {
    return (await this.app.request<{ group: GroupInfo }>(`${HTTP_API_PREFIX}/groups`, {
      method: "POST",
      body: input as unknown as ObjectData,
    })).group;
  }

  async createTrusted(
    input: { name: string; slug: string },
    adminKey: string,
  ): Promise<GroupInfo> {
    return (await this.app.request<{ group: GroupInfo }>(`${HTTP_API_PREFIX}/admin/groups`, {
      method: "POST",
      headers: { "x-armadillo-admin-key": adminKey },
      body: input as unknown as ObjectData,
    })).group;
  }

  async members(groupId: string): Promise<GroupMember[]> {
    return (await this.app.request<{ members: GroupMember[] }>(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members`,
    )).members;
  }

  async addMember(
    groupId: string,
    input: { email: string; role: string },
  ): Promise<GroupMember> {
    return (await this.app.request<{ member: GroupMember }>(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members`,
      { method: "POST", body: input as unknown as ObjectData },
    )).member;
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.app.request<void>(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * Hand team ownership to a current member. Only the owner may call it;
   * the previous owner steps down to admin. Both updates commit atomically.
   */
  async transferOwnership(
    groupId: string,
    input: { email: string },
  ): Promise<{ member: GroupMember; previousOwner: GroupMember }> {
    return this.app.request<{ member: GroupMember; previousOwner: GroupMember }>(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/transfer`,
      { method: "POST", body: input as unknown as ObjectData },
    );
  }
}

export class EventsClient {
  constructor(private readonly app: AnyArmadillo) {}

  async list<TData extends ObjectData = ObjectData>(options: {
    after?: string;
    limit?: number;
  } = {}): Promise<ArmadilloEvent<TData>[]> {
    const parameters = new URLSearchParams();
    if (options.after) parameters.set("after", options.after);
    if (options.limit !== undefined) parameters.set("limit", String(options.limit));
    const query = parameters.size > 0 ? `?${parameters}` : "";
    return (await this.app.request<{ events: ArmadilloEvent<TData>[] }>(
      `${HTTP_API_PREFIX}/events${query}`,
    )).events;
  }
}

export class AuthClient {
  constructor(private readonly app: AnyArmadillo) {}

  async signUp(input: SignUpInput): Promise<User>;
  async signUp(input: SignUpInput, options: LogInOptions): Promise<TokenSession>;
  async signUp(input: SignUpInput, options?: LogInOptions): Promise<User | TokenSession> {
    const result = await this.app.request<SessionEnvelope>(`${HTTP_API_PREFIX}/auth/signup`, {
      method: "POST",
      body: input as unknown as ObjectData,
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" },
    });
    return this.acceptSession(result, options);
  }

  async logIn(input: LogInInput): Promise<User>;
  async logIn(input: LogInInput, options: LogInOptions): Promise<TokenSession>;
  async logIn(input: LogInInput, options?: LogInOptions): Promise<User | TokenSession> {
    const result = await this.app.request<SessionEnvelope>(`${HTTP_API_PREFIX}/auth/login`, {
      method: "POST",
      body: input as unknown as ObjectData,
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" },
    });
    return this.acceptSession(result, options);
  }

  private acceptSession(result: SessionEnvelope, options?: LogInOptions): User | TokenSession {
    if (options?.mode === "token") {
      if (!result.token || !result.expiresAt) throw new ArmadilloError("The backend did not issue a token session.", {
        code: "INTERNAL_ERROR", status: 500,
      });
      return { user: result.user, token: result.token, expiresAt: result.expiresAt };
    }
    this.app.notifyAuth(result.user);
    return result.user;
  }

  async requestMagicLink(input: MagicLinkInput): Promise<{ queued: true; debugToken?: string }> {
    return this.app.request<{ queued: true; debugToken?: string }>(`${HTTP_API_PREFIX}/auth/magic-link`, {
      method: "POST",
      body: input,
    });
  }

  async verifyMagicLink(token: string): Promise<User>;
  async verifyMagicLink(token: string, options: LogInOptions): Promise<TokenSession>;
  async verifyMagicLink(token: string, options?: LogInOptions): Promise<User | TokenSession> {
    const result = await this.app.request<SessionEnvelope>(`${HTTP_API_PREFIX}/auth/verify`, {
      method: "POST",
      body: { token },
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" },
    });
    return this.acceptSession(result, options);
  }

  async bootstrap(input: BootstrapInput): Promise<User>;
  async bootstrap(input: BootstrapInput, options: LogInOptions): Promise<TokenSession>;
  async bootstrap(input: BootstrapInput, options?: LogInOptions): Promise<User | TokenSession> {
    const result = await this.app.request<SessionEnvelope>(`${HTTP_API_PREFIX}/admin/bootstrap`, {
      method: "POST",
      body: input,
      headers: { "x-armadillo-bootstrap-secret": input.secret, "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" },
    });
    return this.acceptSession(result, options);
  }

  async logOut(): Promise<void> {
    try {
      await this.app.request<void>(`${HTTP_API_PREFIX}/auth/logout`, { method: "POST" });
    } catch (error) {
      // Logging out an already-ended browser session is intentionally benign.
      if (!(error instanceof ArmadilloError && error.code === "UNAUTHENTICATED")) throw error;
    } finally {
      this.app.notifyAuth(null);
    }
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    await this.app.request<void>(`${HTTP_API_PREFIX}/auth/password`, {
      method: "POST",
      body: input as unknown as ObjectData,
    });
  }

  async currentUser(): Promise<User | null> {
    try {
      const result = await this.app.request<{ user: User }>(`${HTTP_API_PREFIX}/auth/me`);
      return result.user;
    } catch (error) {
      if (error instanceof ArmadilloError && error.code === "UNAUTHENTICATED") {
        this.app.notifyAuth(null);
        return null;
      }
      throw error;
    }
  }

  onChange(listener: AuthListener): () => void {
    return this.app.subscribeAuth(listener);
  }
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
  update(changes: Partial<T>, options?: { optimistic?: boolean }): Promise<ArmadilloObject<T, TPath>>;
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


const FORBIDDEN_ASSIGN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Copy own data properties without letting __proto__ replace the prototype. */
function assignOwnData(target: object, source: object): void {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(target, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

function hydrate<
  T extends ObjectData,
  TCreate extends ObjectData,
  TRelations extends Record<string, ObjectData>,
  TPath extends string,
>(
  table: Table<T, TCreate, TRelations, TPath>,
  raw: RawObject,
): ArmadilloObject<T, TPath> {
  const record = { ...raw } as unknown as ArmadilloObject<T, TPath>;
  // Monotonic marker for write ordering on this record. Every apply — optimistic
  // success, optimistic rollback, or awaited update — is ignored when a newer
  // attempt has already been issued.
  let generation = 0;
  Object.defineProperties(record, {
    files: {
      enumerable: false,
      value: table.files(raw.id),
    },
    expand: {
      enumerable: false,
      value: (path: string) => table.expandRecord(raw.id, path),
    },
    update: {
      enumerable: false,
      value: async (changes: Partial<T>, options: { optimistic?: boolean } = {}) => {
        if (options.optimistic) {
          const previousProto = Object.getPrototypeOf(record);
          // Order matters: an optimistic update that lands after a newer one
          // must not be applied at all, in either direction. Without this, a slow
          // failure rolled the record back over a value that had already been
          // committed, and a slow success overwrote a newer optimistic value.
          generation += 1;
          const attempt = generation;
          const present = new Set<string>();
          const previous: Record<string, unknown> = {};
          for (const key of Object.keys(changes)) {
            if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
            if (Object.hasOwn(record, key)) {
              present.add(key);
              previous[key] = record[key as keyof typeof record];
            }
          }
          assignOwnData(record, changes);
          table.invalidateQueries();
          void table.update(raw.id, changes).then((updated) => {
            if (attempt !== generation) return;
            assignOwnData(record, updated);
          }).catch((error: unknown) => {
            if (attempt !== generation) return;
            // Restore only the keys this attempt touched, and delete the ones it
            // added: assigning `undefined` would leave the key present.
            for (const key of Object.keys(changes)) {
              if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
              if (present.has(key)) {
                Object.defineProperty(record, key, {
                  value: previous[key], enumerable: true, writable: true, configurable: true,
                });
              } else {
                delete (record as Record<string, unknown>)[key];
              }
            }
            Object.setPrototypeOf(record, previousProto);
            table.notifyCacheError(error);
          });
          return record;
        }
        const updated = await table.update(raw.id, changes);
        // A newer optimistic attempt may be in flight; do not stomp it.
        generation += 1;
        assignOwnData(record, updated);
        return record;
      },
    },
    delete: {
      enumerable: false,
      value: () => table.delete(raw.id),
    },
    toJSON: {
      enumerable: false,
      value: () => ({ ...record }),
    },
  });
  return record;
}

const WHERE_SYSTEM_FIELDS = new Set(["id", "ownerId", "createdAt", "updatedAt"]);
const INCLUDE_DEPTH_MESSAGE = "Includes go 3 deep. Need more? Pluck it out and .expand() it.";

export class Table<
  T extends ObjectData = ObjectData,
  TCreate extends ObjectData = T,
  TRelations extends Record<string, ObjectData> = Record<string, ObjectData>,
  TPath extends string = string,
> {
  readonly name: string;
  /** Inventory tokens for this table's tickets field. Not `app.tickets`. */
  readonly tickets: {
    issue(recordId: string, options?: AuthOperationOptions): Promise<{ token: string }>;
    consume(token: string, options?: AuthOperationOptions): Promise<{
      ok: true;
      remaining: number | null;
      soldOut: boolean;
      idempotent?: true;
    }>;
  };

  constructor(
    private readonly app: AnyArmadillo,
    name: string,
    private readonly fieldNames?: ReadonlySet<string>,
  ) {
    this.name = name;
    this.tickets = {
      issue: (recordId, options = {}) => this.app.request<{ token: string }>(
        `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/tickets/issue`,
        { method: "POST", body: { recordId }, ...options },
      ),
      consume: (token, options = {}) => this.app.request<{
        ok: true;
        remaining: number | null;
        soldOut: boolean;
        idempotent?: true;
      }>(
        `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/tickets/consume`,
        { method: "POST", body: { token }, ...options },
      ),
    };
  }

  async create(data: TCreate, options: AuthOperationOptions = {}): Promise<ArmadilloObject<T, TPath>> {
    const result = await this.app.request<{ object: RawObject }>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}`,
      { method: "POST", body: { data }, ...options },
    );
    this.invalidateQueries();
    return hydrate(this, result.object);
  }

  async createMany(items: TCreate[], options: AuthOperationOptions = {}): Promise<ArmadilloObject<T, TPath>[]> {
    const result = await this.app.request<{ objects: RawObject[] }>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}`,
      { method: "POST", body: { data: items }, ...options },
    );
    this.invalidateQueries();
    return result.objects.map((raw) => hydrate(this, raw));
  }

  async get(id: string, options: AuthOperationOptions = {}): Promise<ArmadilloObject<T, TPath>> {
    const result = await this.app.request<{ object: RawObject }>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      options,
    );
    return hydrate(this, result.object);
  }

  async update(id: string, changes: Partial<T>, options: AuthOperationOptions = {}): Promise<ArmadilloObject<T, TPath>> {
    const result = await this.app.request<{ object: RawObject }>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      { method: "PATCH", body: { data: changes as ObjectData }, ...options },
    );
    this.invalidateQueries();
    return hydrate(this, result.object);
  }

  async delete(id: string, options: AuthOperationOptions = {}): Promise<void> {
    await this.app.request<void>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      { method: "DELETE", ...options },
    );
    this.invalidateQueries();
  }

  query(): Query<T, TCreate, T, TRelations, TPath> {
    return new Query<T, TCreate, T, TRelations, TPath>(this.app, this);
  }

  /**
   * Sugar for `query().where(...).include(...).limit(...).find()`.
   * `where` keys are fields on this table only.
   */
  async find(options: {
    where?: Partial<T>;
    include?: IncludeTree;
    limit?: number;
  } = {}): Promise<ArmadilloObject<T, TPath>[]> {
    const query = this.query();
    if (options.where) query.where(options.where);
    if (options.include !== undefined) query.include(options.include);
    if (options.limit !== undefined) query.limit(options.limit);
    return query.find();
  }

  subscribe(options: {
    where?: Partial<T>;
    onChange(event: RealtimeEvent<ArmadilloObject<T, TPath>>): void;
  }): RealtimeSubscription<ArmadilloObject<T, TPath>> {
    return this.app.realtime.subscribe<ArmadilloObject<T, TPath>>({
      channel: `table:${this.name}`,
      ...(options.where ? { where: options.where as Partial<ArmadilloObject<T, TPath>> } : {}),
      onChange: (event) => {
        const record = event.record && typeof event.record === "object" && "id" in event.record
          ? this.hydrate(event.record as unknown as RawObject)
          : event.record;
        options.onChange({ ...event, record });
      },
    });
  }

  files(id: string): RecordFilesClient {
    return new RecordFilesClient(this.app, this.name, id);
  }

  /** @internal */
  hydrate(raw: RawObject): ArmadilloObject<T, TPath> {
    return hydrate(this, raw);
  }

  /** @internal */
  async expandRecord(id: string, path: string): Promise<ObjectData | string | null> {
    const segments = path.split(".");
    if (segments.length > 8) {
      throw new ArmadilloError("expand() accepts at most 8 segments.", { code: "BAD_REQUEST", status: 400 });
    }
    const result = await this.app.request<{ value: ObjectData | string | null; collection?: string }>(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}/expand`,
      { method: "POST", body: { path } },
    );
    const value = result.value;
    if (!value || typeof value !== "object") return value;
    if (!result.collection || result.collection === "_User" || result.collection === "_Team") return value;
    if (typeof value.id !== "string") return value;
    return new Table(this.app, result.collection).hydrate(value as RawObject);
  }

  /** @internal */
  rejectForeignWhere(field: string): void {
    if (!this.fieldNames) return;
    const dot = field.indexOf(".");
    const root = dot === -1 ? field : field.slice(0, dot);
    if (dot === -1 && (this.fieldNames.has(field) || WHERE_SYSTEM_FIELDS.has(field))) return;
    if (dot !== -1 && root && this.fieldNames.has(root)) return;
    throw new ArmadilloError(
      `where field \`${field}\` is not on ${this.name}. where does not walk onto an included table.`,
      { code: "BAD_REQUEST", status: 400 },
    );
  }

  /** @internal */
  invalidateQueries(): void {
    this.app.cache.invalidate(this.name);
  }

  /** @internal */
  notifyCacheError(error: unknown): void {
    this.app.notifyCacheError(error);
  }
}

type PointerKeysOf<TTable extends TableDefinition> = {
  [TKey in keyof TTable["fields"]]: TTable["fields"][TKey] extends { readonly __target: string }
    ? TKey extends string ? TKey : never
    : never;
}[keyof TTable["fields"]];

type TwoHopPaths<TSchema extends SchemaDefinition, TTable extends TableDefinition> = {
  [TKey in keyof TTable["fields"] & string]: TTable["fields"][TKey] extends { readonly __target: infer TTarget extends string }
    ? TTarget extends keyof TSchema["tables"]
      ? TSchema["tables"][TTarget] extends TableDefinition
        ? PointerKeysOf<TSchema["tables"][TTarget]> extends infer TNext
          ? TNext extends string ? `${TKey}.${TNext}` : never
          : never
        : never
      : never
    : never;
}[keyof TTable["fields"] & string];

/** One- and two-segment forward ref paths. An unknown segment is not in the union. */
export type ExpandPath<TSchema extends SchemaDefinition, TTable extends TableDefinition> =
  PointerKeysOf<TTable> | TwoHopPaths<TSchema, TTable>;

export type SchemaTables<TSchema extends SchemaDefinition> = {
  [TName in keyof TSchema["tables"]]: TSchema["tables"][TName] extends TableDefinition
    ? Table<
      SchemaRecordData<TSchema["tables"][TName]>,
      SchemaCreateData<TSchema["tables"][TName]>,
      SchemaRelationMap<TSchema, TSchema["tables"][TName]>,
      ExpandPath<TSchema, TSchema["tables"][TName]>
    >
    : never;
};

type RelationValue<TSchema extends SchemaDefinition, TField> =
  TField extends { readonly __target: infer TTarget extends string }
    ? TTarget extends keyof TSchema["tables"]
      ? TSchema["tables"][TTarget] extends TableDefinition
        ? SchemaRecordData<TSchema["tables"][TTarget]>
        : ObjectData
      : TTarget extends "_User"
        ? ObjectData & Pick<User, "id" | "name">
        : TTarget extends "_Team"
          ? ObjectData & Pick<TeamInfo, "id" | "name" | "slug">
          : ObjectData
    : never;

type SchemaRelationMap<
  TSchema extends SchemaDefinition,
  TTable extends TableDefinition,
> = {
  [TKey in keyof TTable["fields"] as TTable["fields"][TKey] extends { readonly __target: string }
    ? TKey
    : never]: RelationValue<TSchema, TTable["fields"][TKey]>;
};

type QueryOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "contains";

interface QueryFilter {
  field: string;
  operator: QueryOperator;
  value: JsonValue;
}

interface QueryOrder {
  field: string;
  direction: "asc" | "desc";
}

/**
 * An include takes no options. `limit`, `orderBy`, and `descending` were typed
 * here and dropped by the server, which returned up to 100 rows per parent in id
 * order; they are gone from the type, refused here for JavaScript callers, and
 * 400 on the wire. Query the related table on its own to limit or order it.
 */
export interface ExpandOptions {
  expand?: string | readonly string[];
}

interface QueryExpand {
  field: string;
  expand?: Array<string | QueryExpand>;
}

/** One sentence, one place: why an option on `expand()` cannot be honoured. */
function unsupportedExpandOption(key: string): string {
  return `expand(field, { ${key} }) is not supported. An include takes no options: it returns up to 100 rows per parent, ordered by id. Query that table on its own for a limit or an order.`;
}

/** Reject an unsupported option before the request, not after a silent drop. */
function assertExpandOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (key === "expand") continue;
    throw new ArmadilloError(unsupportedExpandOption(key), { code: "BAD_REQUEST", status: 400 });
  }
}

export type IncludeTree =
  | string
  | readonly string[]
  | { readonly [key: string]: true | { readonly include: IncludeTree } };

function isIncludeRecord(
  value: IncludeTree,
): value is { readonly [key: string]: true | { readonly include: IncludeTree } } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileInclude(value: IncludeTree, depth: number): QueryExpand[] {
  if (depth > 3) {
    throw new ArmadilloError(INCLUDE_DEPTH_MESSAGE, { code: "BAD_REQUEST", status: 400 });
  }
  if (typeof value === "string") {
    if (!value) throw new TypeError("Include field is empty.");
    return [{ field: value }];
  }
  if (Array.isArray(value)) {
    if (value.length > 10) {
      throw new ArmadilloError("An include level has more than 10 keys.", { code: "BAD_REQUEST", status: 400 });
    }
    return value.map((field) => {
      if (typeof field !== "string" || !field) throw new TypeError("Include field is invalid.");
      return { field };
    });
  }
  if (!isIncludeRecord(value)) throw new TypeError("Include value is invalid.");
  const keys = Object.keys(value);
  if (keys.length > 10) {
    throw new ArmadilloError("An include level has more than 10 keys.", { code: "BAD_REQUEST", status: 400 });
  }
  return keys.map((field) => {
    const child = value[field];
    if (child === true) return { field };
    if (child && typeof child === "object" && "include" in child) {
      const nested = compileInclude(child.include, depth + 1);
      return nested.length > 0 ? { field, expand: nested } : { field };
    }
    throw new TypeError("Include value must be true or { include }.");
  });
}

interface NearConstraint {
  field: string;
  center: GeoPoint;
  radius: number;
  unit: DistanceUnit;
}

interface BoundingBoxConstraint extends GeoBoundingBox {
  field: string;
}

interface SpatialOrder {
  field: string;
  center: GeoPoint;
  direction: "nearest" | "farthest";
}

type ExpandedResult<
  T extends ObjectData,
  TRelations extends Record<string, ObjectData>,
  K extends keyof T & keyof TRelations & string,
> = Omit<T, K> & {
  [P in K]: (TRelations[P] & {
    id: string;
    ownerId?: string;
    createdAt?: string;
    updatedAt?: string;
  }) | null;
};

export class Query<
  T extends ObjectData = ObjectData,
  TCreate extends ObjectData = T,
  TResult extends ObjectData = T,
  TRelations extends Record<string, ObjectData> = Record<string, ObjectData>,
  TPath extends string = string,
> {
  private readonly filters: QueryFilter[] = [];
  private readonly ordering: QueryOrder[] = [];
  private maximum = 100;
  private offset = 0;
  private limitTouched = false;
  private readonly expands: QueryExpand[] = [];
  private readonly nearConstraints: NearConstraint[] = [];
  private readonly boundingBoxes: BoundingBoxConstraint[] = [];
  private spatialOrder: SpatialOrder | undefined;
  private includeDistance: string | undefined;

  constructor(
    private readonly app: AnyArmadillo,
    private readonly table: Table<T, TCreate, TRelations, TPath>,
  ) {}

  where(fields: Partial<T>): this;
  where<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this;
  where(fieldOrFields: (keyof T & string) | Partial<T>, value?: JsonValue): this {
    if (typeof fieldOrFields === "string") {
      if (value === undefined) throw new TypeError("where(field, value) requires a value.");
      return this.addFilter(fieldOrFields, "eq", value);
    }
    for (const [field, fieldValue] of Object.entries(fieldOrFields)) {
      if (fieldValue !== undefined) this.addFilter(field, "eq", fieldValue);
    }
    return this;
  }

  equalTo<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this {
    return this.addFilter(field, "eq", value);
  }

  /** Match a primitive at a bounded object path within a declared JSON field. */
  whereJsonPath(field: keyof T & string, path: string, value: JsonPrimitive): this {
    return this.addFilter(`${field}.${path}`, "eq", value);
  }

  notEqualTo<TKey extends keyof T & string>(field: TKey, value: T[TKey]): this {
    return this.addFilter(field, "ne", value);
  }

  lessThan(field: keyof T & string, value: JsonPrimitive): this {
    return this.addFilter(field, "lt", value);
  }

  lessThanOrEqualTo(field: keyof T & string, value: JsonPrimitive): this {
    return this.addFilter(field, "lte", value);
  }

  greaterThan(field: keyof T & string, value: JsonPrimitive): this {
    return this.addFilter(field, "gt", value);
  }

  greaterThanOrEqualTo(field: keyof T & string, value: JsonPrimitive): this {
    return this.addFilter(field, "gte", value);
  }

  containedIn(field: keyof T & string, values: JsonPrimitive[]): this {
    return this.addFilter(field, "in", values);
  }

  contains(field: keyof T & string, value: string): this {
    return this.addFilter(field, "contains", value);
  }

  orderBy(
    field: (keyof T & string) | "createdAt" | "updatedAt",
    direction: "asc" | "desc" | {
      descending?: boolean;
      nearest?: GeoPoint;
      farthest?: GeoPoint;
    } = "asc",
  ): this {
    if (typeof direction === "object") {
      const center = direction.nearest ?? direction.farthest;
      if (center) {
        assertGeoPoint(center);
        this.spatialOrder = {
          field,
          center,
          direction: direction.farthest ? "farthest" : "nearest",
        };
        return this;
      }
      this.ordering.push({ field, direction: direction.descending ? "desc" : "asc" });
      return this;
    }
    this.ordering.push({ field, direction });
    return this;
  }

  ascending(field: (keyof T & string) | "createdAt" | "updatedAt"): this {
    return this.orderBy(field, "asc");
  }

  descending(field: (keyof T & string) | "createdAt" | "updatedAt"): this {
    return this.orderBy(field, "desc");
  }

  limit(maximum: number): this {
    this.maximum = maximum;
    this.limitTouched = true;
    return this;
  }

  skip(offset: number): this {
    this.offset = offset;
    return this;
  }

  expand<K extends keyof TResult & keyof TRelations & string>(
    field: K,
    options: ExpandOptions = {},
  ): Query<T, TCreate, ExpandedResult<TResult, TRelations, K>, TRelations, TPath> {
    assertExpandOptions(options);
    this.expands.push({
      field,
      ...(options.expand ? { expand: typeof options.expand === "string" ? [options.expand] : [...options.expand] } : {}),
    });
    return this as unknown as Query<T, TCreate, ExpandedResult<TResult, TRelations, K>, TRelations, TPath>;
  }

  /** Tree include. Depth 4 throws before the request. Sends the same expands payload as expand(). */
  include(spec: IncludeTree): this {
    for (const entry of compileInclude(spec, 1)) this.expands.push(entry);
    return this;
  }

  near(
    field: keyof T & string,
    options: { center: GeoPoint; radius: number; unit?: DistanceUnit },
  ): this {
    assertGeoPoint(options.center);
    distanceInMeters(options.radius, options.unit);
    this.nearConstraints.push({
      field,
      center: options.center,
      radius: options.radius,
      unit: options.unit ?? "meters",
    });
    return this;
  }

  withinBoundingBox(
    field: keyof T & string,
    bounds: GeoBoundingBox,
  ): this {
    assertGeoPoint(bounds.northEast);
    assertGeoPoint(bounds.southWest);
    if (bounds.northEast.latitude < bounds.southWest.latitude) {
      throw new TypeError("Bounding-box northEast latitude must be north of southWest.");
    }
    this.boundingBoxes.push({ field, ...bounds });
    return this;
  }

  select(options: { includeDistance: keyof T & string }): Query<
    T,
    TCreate,
    TResult & { _distance: number },
    TRelations,
    TPath
  > {
    this.includeDistance = options.includeDistance;
    return this as unknown as Query<T, TCreate, TResult & { _distance: number }, TRelations, TPath>;
  }

  async find(options: AuthOperationOptions = {}): Promise<ArmadilloObject<TResult, TPath>[]> {
    if (!this.limitTouched) {
      return this.findEveryPage(options);
    }
    const payload = this.payload(false);
    const key = queryCacheKey(this.table.name, payload);
    // Per-request credentials are deliberately never cached or stored as keys.
    const cached = options.auth ? undefined : this.app.cache.get<RawObject[]>(key);
    if (this.app.cache.strategy === "cache-first" && cached && !cached.stale) {
      return cached.value.map((raw) => this.table.hydrate(raw) as unknown as ArmadilloObject<TResult, TPath>);
    }
    if (this.app.cache.strategy === "stale-while-revalidate" && cached) {
      if (cached.stale) void this.fetchAndCache(key, payload, options).catch((error) => this.app.notifyCacheError(error));
      return cached.value.map((raw) => this.table.hydrate(raw) as unknown as ArmadilloObject<TResult, TPath>);
    }
    const results = await this.fetchAndCache(key, payload, options);
    return results.map((raw) => this.table.hydrate(raw) as unknown as ArmadilloObject<TResult, TPath>);
  }

  /**
   * Page an untouched find() with skip until a short page. Page size 100 is internal.
   *
   * The assembled result is cached under the untouched-query key, because that
   * is the shape `table("X").query().find()` — the most common call there is —
   * takes. Without this, `cache-first` never served a hit for it and every read
   * went to the network, which is the opposite of what the strategy promises.
   */
  private async findEveryPage(options: AuthOperationOptions = {}): Promise<ArmadilloObject<TResult, TPath>[]> {
    const key = queryCacheKey(this.table.name, this.payload(false));
    const revision = this.app.cache.revision;
    // Per-request credentials are deliberately never cached or stored as keys.
    if (!options.auth && this.app.cache.strategy !== "network-only") {
      const cached = this.app.cache.get<RawObject[]>(key);
      if (cached && (this.app.cache.strategy === "cache-first" ? !cached.stale : true)) {
        if (cached.stale) {
          void this.findEveryPageInto(key, options).catch((error) => this.app.notifyCacheError(error));
        }
        return cached.value.map((raw) => this.table.hydrate(raw) as unknown as ArmadilloObject<TResult, TPath>);
      }
    }
    return this.findEveryPageInto(key, options, revision);
  }

  private async findEveryPageInto(
    key: string,
    options: AuthOperationOptions = {},
    revision = this.app.cache.revision,
  ): Promise<ArmadilloObject<TResult, TPath>[]> {
    const pageSize = 100;
    const serverSkipMax = 10_000;
    const rows: RawObject[] = [];
    let skip = this.offset;
    for (;;) {
      const payload = { ...this.payload(false), limit: pageSize, skip };
      const page = await this.app.request<{ results: RawObject[] }>(
        `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
        { method: "POST", body: payload, ...options },
      );
      rows.push(...page.results);
      if (page.results.length < pageSize) break;
      const nextSkip = skip + pageSize;
      if (nextSkip > serverSkipMax) {
        const total = await this.count(options);
        if (total > rows.length) {
          throw new ArmadilloError(
            `Query result exceeds the server skip window (${serverSkipMax}). Narrow the query or page explicitly with limit() and skip().`,
            { code: "BAD_REQUEST", status: 400 },
          );
        }
        break;
      }
      skip = nextSkip;
    }
    // A mutation that landed while these pages were in flight must not be undone
    // by a cache write built from a read that straddled it.
    if (!options.auth && this.app.cache.strategy !== "network-only" && revision === this.app.cache.revision) {
      this.app.cache.set(key, this.table.name, rows);
    }
    return rows.map((raw) => this.table.hydrate(raw) as unknown as ArmadilloObject<TResult, TPath>);
  }

  private async fetchAndCache(key: string, payload: ObjectData, options: AuthOperationOptions = {}): Promise<RawObject[]> {
    const revision = this.app.cache.revision;
    const result = await this.app.request<{ results: RawObject[] }>(
      `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
      { method: "POST", body: payload, ...options },
    );
    if (!options.auth && this.app.cache.strategy !== "network-only" && revision === this.app.cache.revision) {
      this.app.cache.set(key, this.table.name, result.results);
    }
    return result.results;
  }

  async first(options: AuthOperationOptions = {}): Promise<ArmadilloObject<TResult, TPath> | null> {
    const previous = this.maximum;
    const previousTouched = this.limitTouched;
    this.maximum = 1;
    this.limitTouched = true;
    try {
      return (await this.find(options))[0] ?? null;
    } finally {
      this.maximum = previous;
      this.limitTouched = previousTouched;
    }
  }

  async count(options: AuthOperationOptions = {}): Promise<number> {
    const result = await this.app.request<{ count: number }>(
      `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
      { method: "POST", body: this.payload(true), ...options },
    );
    return result.count;
  }

  private addFilter(field: string, operator: QueryOperator, value: JsonValue): this {
    this.table.rejectForeignWhere(field);
    this.filters.push({ field, operator, value });
    return this;
  }

  private payload(count: boolean): ObjectData {
    return {
      filters: this.filters as unknown as JsonValue,
      order: this.ordering as unknown as JsonValue,
      limit: this.maximum,
      skip: this.offset,
      count,
      ...(this.expands.length > 0 ? { expands: this.expands as unknown as JsonValue } : {}),
      ...(this.nearConstraints.length > 0 ? { near: this.nearConstraints as unknown as JsonValue } : {}),
      ...(this.boundingBoxes.length > 0 ? { boundingBoxes: this.boundingBoxes as unknown as JsonValue } : {}),
      ...(this.spatialOrder ? { spatialOrder: this.spatialOrder as unknown as JsonValue } : {}),
      ...(this.includeDistance ? { includeDistance: this.includeDistance } : {}),
    };
  }
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

function hydrateFile(files: FilesClient, raw: FileInfo): ArmadilloFile {
  const file = { ...raw } as ArmadilloFile;
  Object.defineProperties(file, {
    download: {
      enumerable: false,
      value: () => files.download(raw.id),
    },
    url: {
      enumerable: false,
      value: () => files.url(raw.id),
    },
    delete: {
      enumerable: false,
      value: () => files.delete(raw.id),
    },
  });
  return file;
}

export class FilesClient {
  constructor(private readonly app: AnyArmadillo) {}

  async upload(blob: Blob, options: UploadOptions = {}): Promise<ArmadilloFile> {
    const mode = options.mode ?? "auto";
    if (mode === "direct") return this.uploadDirect(blob, options);
    if (mode === "multipart" || (mode === "auto" && blob.size > 100 * 1_024 * 1_024)) {
      return this.uploadMultipart(blob, options);
    }
    const candidateName = (blob as Blob & { name?: unknown }).name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const result = await this.app.request<{ file: FileInfo }>(`${HTTP_API_PREFIX}/files`, {
      method: "POST",
      body: blob,
      headers: {
        "content-type": contentType,
        "x-armadillo-file-name": encodeURIComponent(name),
      },
      ...options,
    });
    return hydrateFile(this, result.file);
  }

  async uploadDirect(blob: Blob, options: UploadOptions = {}): Promise<ArmadilloFile> {
    const candidateName = (blob as Blob & { name?: unknown }).name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const intent = await this.app.request<{
      upload: { id: string; uploadUrl: string; method: "PUT"; headers: Record<string, string> };
    }>(`${HTTP_API_PREFIX}/files/presign`, {
      method: "POST",
      body: { name, contentType, size: blob.size },
      ...(options.auth ? { auth: options.auth } : {}),
    });
    const uploaded = await this.app.fetchExternal(intent.upload.uploadUrl, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: blob,
    });
    if (!uploaded.ok) {
      throw new ArmadilloError(`Direct object upload failed (${uploaded.status}).`, {
        code: "INTERNAL_ERROR",
        status: uploaded.status,
      });
    }
    const result = await this.app.request<{ file: FileInfo }>(
      `${HTTP_API_PREFIX}/files/uploads/${encodeURIComponent(intent.upload.id)}/complete`,
      { method: "POST", body: {}, ...(options.auth ? { auth: options.auth } : {}) },
    );
    return hydrateFile(this, result.file);
  }

  async uploadMultipart(blob: Blob, options: UploadOptions = {}): Promise<ArmadilloFile> {
    const candidateName = (blob as Blob & { name?: unknown }).name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const intent = await this.app.request<{
      upload: { id: string; uploadId: string; partSize: number };
    }>(`${HTTP_API_PREFIX}/files/multipart`, {
      method: "POST",
      body: { name, contentType, size: blob.size },
      ...(options.auth ? { auth: options.auth } : {}),
    });
    const partCount = Math.max(1, Math.ceil(blob.size / intent.upload.partSize));
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1;
      const chunk = blob.slice(index * intent.upload.partSize, Math.min(blob.size, partNumber * intent.upload.partSize));
      const result = await this.app.request<{ part: { partNumber: number; etag: string } }>(
        `${HTTP_API_PREFIX}/files/multipart/${encodeURIComponent(intent.upload.id)}/parts/${partNumber}`,
        { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream" }, ...(options.auth ? { auth: options.auth } : {}) },
      );
      return result.part;
    }));
    const result = await this.app.request<{ file: FileInfo }>(
      `${HTTP_API_PREFIX}/files/multipart/${encodeURIComponent(intent.upload.id)}/complete`,
      { method: "POST", body: { parts }, ...(options.auth ? { auth: options.auth } : {}) },
    );
    return hydrateFile(this, result.file);
  }

  async get(id: string, options: AuthOperationOptions = {}): Promise<ArmadilloFile> {
    const result = await this.app.request<{ file: FileInfo }>(
      `${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}/meta`, options,
    );
    return hydrateFile(this, result.file);
  }

  async list(options: AuthOperationOptions = {}): Promise<ArmadilloFile[]> {
    const rows: ArmadilloFile[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listPage({ ...options, ...(cursor ? { cursor } : {}) });
      rows.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }

  async listPage(options: { limit?: number; cursor?: string } & AuthOperationOptions = {}): Promise<{
    files: ArmadilloFile[];
    nextCursor: string | null;
  }> {
    const parameters = new URLSearchParams();
    if (options.limit !== undefined) parameters.set("limit", String(options.limit));
    if (options.cursor) parameters.set("cursor", options.cursor);
    const query = parameters.size ? `?${parameters}` : "";
    const result = await this.app.request<{ files: FileInfo[]; nextCursor: string | null }>(`${HTTP_API_PREFIX}/files${query}`, options);
    return { files: result.files.map((file) => hydrateFile(this, file)), nextCursor: result.nextCursor };
  }

  async download(id: string, options: AuthOperationOptions = {}): Promise<Blob> {
    const response = await this.app.request<Response>(
      `${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}`,
      { raw: true, ...options },
    );
    return response.blob();
  }

  async url(id: string, options: AuthOperationOptions = {}): Promise<string> {
    return (await this.app.request<{ url: string }>(`${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}/url`, options)).url;
  }

  async delete(id: string, options: AuthOperationOptions = {}): Promise<void> {
    await this.app.request<void>(`${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}`, {
      method: "DELETE", ...options,
    });
  }
}

export class RecordFilesClient {
  constructor(
    private readonly app: AnyArmadillo,
    private readonly table: string,
    private readonly objectId: string,
  ) {}

  private path(fileId?: string): string {
    const base = `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.table)}/${encodeURIComponent(this.objectId)}/files`;
    return fileId ? `${base}/${encodeURIComponent(fileId)}` : base;
  }

  async list(): Promise<ArmadilloFile[]> {
    const result = await this.app.request<{ files: FileInfo[] }>(this.path());
    return result.files.map((file) => hydrateFile(this.app.files, file));
  }

  async attach(file: FileInfo | string, position = 0): Promise<ArmadilloFile> {
    const fileId = typeof file === "string" ? file : file.id;
    const result = await this.app.request<{ file: FileInfo }>(this.path(), {
      method: "POST",
      body: { fileId, position },
    });
    return hydrateFile(this.app.files, result.file);
  }

  async upload(blob: Blob, options: UploadOptions = {}): Promise<ArmadilloFile> {
    const file = await this.app.files.upload(blob, options);
    await this.attach(file);
    return file;
  }

  async detach(file: FileInfo | string): Promise<void> {
    await this.app.request<void>(this.path(typeof file === "string" ? file : file.id), { method: "DELETE" });
  }
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

export class ApiKeysClient {
  constructor(private readonly app: AnyArmadillo) {}

  async list(): Promise<ApiKeyInfo[]> {
    const rows: ApiKeyInfo[] = [];
    let cursor: string | null = null;
    do {
      const route: string = cursor
        ? `${HTTP_API_PREFIX}/api-keys?cursor=${encodeURIComponent(cursor)}`
        : `${HTTP_API_PREFIX}/api-keys`;
      const page: { apiKeys: ApiKeyInfo[]; nextCursor?: string | null } = await this.app.request(route);
      rows.push(...page.apiKeys);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  async create(input: { name: string; description?: string; scopes: string[]; expiresAt?: string }): Promise<{
    apiKey: ApiKeyInfo;
    secret: string;
  }> {
    return this.app.request(`${HTTP_API_PREFIX}/api-keys`, { method: "POST", body: input });
  }

  async get(id: string): Promise<ApiKeyInfo> {
    return (await this.app.request<{ apiKey: ApiKeyInfo }>(
      `${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`,
    )).apiKey;
  }

  async update(id: string, input: { name?: string; description?: string | null }): Promise<ApiKeyInfo> {
    return (await this.app.request<{ apiKey: ApiKeyInfo }>(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    })).apiKey;
  }

  async rotate(id: string, options: { gracePeriodSeconds?: number } = {}): Promise<{
    apiKey: ApiKeyInfo;
    secret: string;
  }> {
    return this.app.request(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}/rotate`, {
      method: "POST",
      body: options,
    });
  }

  async audit(id: string): Promise<ApiKeyAuditEvent[]> {
    const rows: ApiKeyAuditEvent[] = [];
    let cursor: string | null = null;
    const key = encodeURIComponent(id);
    do {
      const route: string = cursor
        ? `${HTTP_API_PREFIX}/api-keys/${key}/audit?cursor=${encodeURIComponent(cursor)}`
        : `${HTTP_API_PREFIX}/api-keys/${key}/audit`;
      const page: { audit: ApiKeyAuditEvent[]; nextCursor?: string | null } = await this.app.request(route);
      rows.push(...page.audit);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  async revoke(id: string): Promise<void> {
    await this.app.request<void>(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
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

export class VouchersClient {
  constructor(private readonly app: AnyArmadillo) {}

  async list(): Promise<VoucherInfo[]> {
    const rows: VoucherInfo[] = [];
    let cursor: string | null = null;
    do {
      const route: string = cursor
        ? `${HTTP_API_PREFIX}/vouchers?cursor=${encodeURIComponent(cursor)}`
        : `${HTTP_API_PREFIX}/vouchers`;
      const page: { vouchers: VoucherInfo[]; nextCursor?: string | null } = await this.app.request(route);
      rows.push(...page.vouchers);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  async get(id: string): Promise<VoucherInfo> {
    return (await this.app.request<{ voucher: VoucherInfo }>(`${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}`)).voucher;
  }

  async create(input: { name: string; capacity?: number; expiresAt?: string }): Promise<{
    voucher: VoucherInfo;
    code: string;
  }> {
    return this.app.request(`${HTTP_API_PREFIX}/vouchers`, { method: "POST", body: input });
  }

  async consume(code: string, idempotencyKey: string): Promise<{
    consumed: true;
    idempotent: boolean;
    voucher: VoucherInfo;
  }> {
    return this.app.request(`${HTTP_API_PREFIX}/vouchers/consume`, {
      method: "POST",
      body: { code, idempotencyKey },
    });
  }

  async restock(id: string, amount = 1): Promise<VoucherInfo> {
    return (await this.app.request<{ voucher: VoucherInfo }>(
      `${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}/restock`,
      { method: "POST", body: { amount } },
    )).voucher;
  }

  async expire(id: string): Promise<void> {
    await this.app.request<void>(`${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
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
export class Ticket {
  constructor(
    private readonly client: TicketsClient,
    private readonly code: string,
    private value: TicketInfo,
  ) {}

  get id(): string { return this.value.id; }
  get label(): string { return this.value.label; }
  get status(): TicketStatus { return this.value.status; }
  get consumedAt(): string | null { return this.value.consumedAt; }
  get consumedBy(): string | null { return this.value.consumedBy; }

  toJSON(): TicketInfo { return { ...this.value, metadata: { ...this.value.metadata } }; }

  async consume(idempotencyKey = crypto.randomUUID()): Promise<{
    consumed: true;
    idempotent: boolean;
    ticket: Ticket;
  }> {
    const result = await this.client.consume(this.code, idempotencyKey);
    this.value = result.ticket;
    return { consumed: true, idempotent: result.idempotent, ticket: this };
  }
}

export class TicketsClient {
  constructor(private readonly app: AnyArmadillo) {}

  async list(): Promise<TicketInfo[]> {
    const rows: TicketInfo[] = [];
    let cursor: string | null = null;
    do {
      const route: string = cursor
        ? `${HTTP_API_PREFIX}/tickets?cursor=${encodeURIComponent(cursor)}`
        : `${HTTP_API_PREFIX}/tickets`;
      const page: { tickets: TicketInfo[]; nextCursor?: string | null } = await this.app.request(route);
      rows.push(...page.tickets);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  async get(id: string): Promise<TicketInfo> {
    return (await this.app.request<{ ticket: TicketInfo }>(`${HTTP_API_PREFIX}/tickets/${encodeURIComponent(id)}`)).ticket;
  }

  async issue(input: {
    label: string;
    holderId?: string;
    eventId?: string;
    metadata?: ObjectData;
    expiresAt?: string;
  }): Promise<{ ticket: TicketInfo; code: string }> {
    return this.app.request(`${HTTP_API_PREFIX}/tickets`, { method: "POST", body: input });
  }

  async lookup(code: string): Promise<Ticket> {
    const result = await this.app.request<{ ticket: TicketInfo }>(`${HTTP_API_PREFIX}/tickets/lookup`, {
      method: "POST",
      body: { code },
    });
    return new Ticket(this, code, result.ticket);
  }

  /** @internal Prefer lookup(code).consume() in application UI. */
  async consume(code: string, idempotencyKey: string): Promise<{
    consumed: true;
    idempotent: boolean;
    ticket: TicketInfo;
  }> {
    return this.app.request(`${HTTP_API_PREFIX}/tickets/consume`, {
      method: "POST",
      body: { code, idempotencyKey },
    });
  }
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
  record?: { id: string; collection: string };
}

export class CollectorClient<TData extends ObjectData = ObjectData> {
  constructor(private readonly app: AnyArmadillo, readonly id: string) {}

  async submit(data: ObjectData): Promise<CollectorSubmission<TData>> {
    return (await this.app.request<{ submission: CollectorSubmission<TData> }>(
      `${HTTP_API_PREFIX}/collectors/${encodeURIComponent(this.id)}`,
      { method: "POST", body: { data } },
    )).submission;
  }

  async submissions(): Promise<CollectorSubmission<TData>[]> {
    const rows: CollectorSubmission<TData>[] = [];
    let cursor: string | null = null;
    const collector = encodeURIComponent(this.id);
    do {
      const route: string = cursor
        ? `${HTTP_API_PREFIX}/collectors/${collector}/submissions?cursor=${encodeURIComponent(cursor)}`
        : `${HTTP_API_PREFIX}/collectors/${collector}/submissions`;
      const page: { submissions: CollectorSubmission<TData>[]; nextCursor?: string | null } = await this.app.request(route);
      rows.push(...page.submissions);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
}

export class CollectorsClient {
  constructor(private readonly app: AnyArmadillo) {}
  get<TData extends ObjectData = ObjectData>(id: string): CollectorClient<TData> {
    return new CollectorClient<TData>(this.app, id);
  }
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
  provenance?: { version?: string; bundleHash?: string; deploymentId?: string };
}

export class AppsClient {
  constructor(private readonly app: AnyArmadillo) {}
  async current(): Promise<RegisteredAppInfo> {
    return (await this.app.request<{ app: RegisteredAppInfo }>(`${HTTP_API_PREFIX}/apps/current`)).app;
  }
  async list(): Promise<RegisteredAppInfo[]> {
    return (await this.app.request<{ apps: RegisteredAppInfo[] }>(`${HTTP_API_PREFIX}/apps`)).apps;
  }
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
  memberships: Array<{ groupId: string; groupName: string; groupSlug: string; role: string; trusted: boolean }>;
  sessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
  apiKeys: Array<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: string }>;
  objects: Array<{ collection: string; id: string; data: ObjectData; createdAt: string; updatedAt: string }>;
  files: Array<{ id: string; name: string; contentType: string; size: number; createdAt: string }>;
  collectorSubmissions: Array<{ id: string; collectorId: string; data: ObjectData; createdAt: string; expiresAt: string }>;
  tickets: Array<{ id: string; label: string; metadata: ObjectData; createdAt: string }>;
  generatedAt: string;
  dpoEmail?: string | null;
  privacyPolicyUrl?: string | null;
}

export type GdprErasureResult =
  | { erased: true; strategy: "delete"; details: { deletedObjects: number; deletedFiles: number; deletedCollectorSubs: number; tombstoneEmail: string } }
  | { erased: true; strategy: "anonymize"; details: { anonymized: true; tombstoneEmail: string } };

export class GdprClient {
  constructor(private readonly app: AnyArmadillo) {}

  async info(): Promise<GdprInfo> {
    return (await this.app.request<{ info: GdprInfo }>(`${HTTP_API_PREFIX}/gdpr/info`)).info;
  }

  async consents(): Promise<GdprConsent[]> {
    return (await this.app.request<{ consents: GdprConsent[] }>(`${HTTP_API_PREFIX}/gdpr/consents`)).consents;
  }

  async consent(input: { purpose: string; granted: boolean; metadata?: ObjectData; expiresAt?: string }): Promise<GdprConsent> {
    return (await this.app.request<{ consent: GdprConsent }>(`${HTTP_API_PREFIX}/gdpr/consent`, {
      method: "POST",
      body: input as unknown as ObjectData,
    })).consent;
  }

  async export(): Promise<GdprExportBundle> {
    return (await this.app.request<{ bundle: GdprExportBundle }>(`${HTTP_API_PREFIX}/gdpr/export`, { method: "POST", body: {} })).bundle;
  }

  async rectify(input: { name?: string | null; email?: string }): Promise<User> {
    return (await this.app.request<{ user: User }>(`${HTTP_API_PREFIX}/gdpr/rectify`, {
      method: "POST",
      body: input as unknown as ObjectData,
    })).user;
  }

  async restrict(input: { restricted: boolean; reason?: string }): Promise<{ restricted: boolean }> {
    return this.app.request(`${HTTP_API_PREFIX}/gdpr/restrict`, { method: "POST", body: input as unknown as ObjectData });
  }

  async erase(input: { confirm: string; reason?: string; strategy?: "delete" | "anonymize" }): Promise<GdprErasureResult> {
    return this.app.request(`${HTTP_API_PREFIX}/gdpr/erase`, { method: "POST", body: input as unknown as ObjectData });
  }

  async erasureLog(): Promise<Array<{ id: string; targetUserId: string; actorUserId: string; strategy: string; reason: string | null; createdAt: string; completedAt: string | null }>> {
    return (await this.app.request<{ log: Array<{ id: string; targetUserId: string; actorUserId: string; strategy: string; reason: string | null; createdAt: string; completedAt: string | null }> }>(`${HTTP_API_PREFIX}/gdpr/erasure-log`)).log;
  }
}
