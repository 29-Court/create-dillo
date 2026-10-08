import { HTTP_API_PREFIX } from "./versions.js";
import { QueryCache, queryCacheKey } from "./cache.js";
import { assertGeoPoint, distanceInMeters } from "./geo.js";
import { RealtimeClient } from "./realtime-client.js";
class ArmadilloError extends Error {
  code;
  status;
  fields;
  requestId;
  /** Actionable guidance from the backend. Describes the policy and what to do next. */
  hint;
  constructor(message, options) {
    super(message);
    this.name = "ArmadilloError";
    this.code = options.code;
    this.status = options.status;
    this.fields = options.fields;
    this.requestId = options.requestId;
    this.hint = options.hint;
  }
}
const DEFAULT_APP_ID = "default";
function publicConfig() {
  const value = globalThis.__ARMADILLO__;
  return value && typeof value === "object" ? value : void 0;
}
function sameOrigin() {
  if (typeof location === "undefined" || !location.origin || location.origin === "null") return void 0;
  return location.origin;
}
function normalizeUrl(url) {
  const normalized = url.trim().replace(/\/+$/, "");
  if (!normalized) throw new TypeError("Dillo requires a backend URL.");
  return normalized;
}
function isBody(value) {
  return typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || typeof Blob !== "undefined" && value instanceof Blob || typeof FormData !== "undefined" && value instanceof FormData || typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams || typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}
class ArmadilloClient {
  url;
  appId;
  namespace;
  /** Public deployment metadata; it never contains runtime or API secrets. */
  config;
  auth;
  files;
  groups;
  teams;
  events;
  apiKeys;
  vouchers;
  tickets;
  collectors;
  apps;
  gdpr;
  cache;
  realtime;
  /** Typed function calls when the client is created from a backend type. */
  functions;
  /** Typed table clients from a runtime schema or backend type. */
  tables;
  /**
   * Schema-typed table clients without passing a runtime schema to the browser.
   * Use `Armadillo<typeof schema>()` with a type-only schema import.
   */
  models;
  fetcher;
  clientKey;
  registeredAppId;
  requestNamespace;
  /** Immutable bearer context. Ambient browser auth is intentionally separate. */
  authToken;
  creationOptions;
  authListeners = /* @__PURE__ */ new Set();
  cacheErrorListeners = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    const candidate = publicConfig();
    const explicitUrl = options.url ?? options.endpoint;
    const embeddedUrl = candidate?.url ?? sameOrigin();
    const embedded = !explicitUrl || embeddedUrl && normalizeUrl(explicitUrl) === normalizeUrl(embeddedUrl) ? candidate : void 0;
    const endpoint = options.url ?? options.endpoint ?? embedded?.url ?? sameOrigin();
    if (!endpoint) throw new TypeError("Dillo needs a url or endpoint.");
    this.url = normalizeUrl(endpoint);
    this.registeredAppId = options.appId?.trim() || void 0;
    this.requestNamespace = options.namespace?.trim() || embedded?.appId?.trim() || this.registeredAppId;
    this.appId = this.registeredAppId ?? embedded?.appId?.trim() ?? DEFAULT_APP_ID;
    this.namespace = this.requestNamespace ?? DEFAULT_APP_ID;
    this.config = Object.freeze({
      url: this.url,
      ...this.registeredAppId || this.requestNamespace ? { appId: this.registeredAppId ?? this.requestNamespace } : {},
      ...embedded?.stage ? { stage: embedded.stage } : {},
      ...embedded?.public ? { public: Object.freeze({ ...embedded.public }) } : {}
    });
    this.clientKey = options.clientKey?.trim() || void 0;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.authToken = options.credential?.trim() || void 0;
    const { credential: _credential, appId: _appId, endpoint: _endpoint, ...cloneOptions } = options;
    void _credential;
    void _appId;
    void _endpoint;
    this.creationOptions = {
      ...cloneOptions,
      url: this.url,
      ...this.registeredAppId ? { appId: this.registeredAppId } : {},
      ...this.requestNamespace ? { namespace: this.requestNamespace } : {}
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
      get: (_target, name) => typeof name === "string" ? (data = {}, requestOptions = {}) => this.call(name, data, requestOptions) : void 0
    });
    this.realtime = new RealtimeClient({
      url: this.url,
      ...this.registeredAppId ? { clientAppId: this.registeredAppId } : {},
      ...this.requestNamespace ? { namespace: this.requestNamespace } : {},
      ...options.realtimeUrl ? { realtimeUrl: options.realtimeUrl } : {},
      credential: () => this.authToken ?? null,
      ...this.clientKey ? { clientKey: this.clientKey } : {},
      ...options.webSocket ? { webSocket: options.webSocket } : {}
    });
    this.tables = options.schema ? this.schema(options.schema) : new Proxy({}, {
      get: (_target, name) => typeof name === "string" ? this.table(name) : void 0
    });
    this.models = this.tables;
  }
  /**
   * Return a new client whose bearer credential is fixed for its lifetime.
   * This never changes this client, browser cookies, or any other context.
   */
  withAuth(token) {
    const credential = token.trim();
    if (!credential) throw new TypeError("withAuth(token) requires a bearer token.");
    return new ArmadilloClient({ ...this.creationOptions, credential });
  }
  table(name) {
    return new Table(this, name);
  }
  schema(definition) {
    const result = {};
    for (const name of Object.keys(definition.tables)) {
      const fields = definition.tables[name]?.fields;
      result[name] = new Table(this, name, new Set(fields ? Object.keys(fields) : []));
    }
    return result;
  }
  async call(name, data = {}, options = {}) {
    const result = await this.request(
      `${HTTP_API_PREFIX}/functions/${encodeURIComponent(name)}`,
      { method: "POST", body: { data }, ...options }
    );
    return result.result;
  }
  /** Submit to a typed collector with the least possible ceremony. */
  async collect(collectorId, data) {
    return this.collectors.get(collectorId).submit(data);
  }
  /** @internal */
  subscribeAuth(listener) {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }
  /** @internal */
  notifyAuth(user) {
    this.cache.invalidateAll();
    for (const listener of this.authListeners) listener(user);
  }
  /** Observe failed background cache revalidations and optimistic mutations. */
  onCacheError(listener) {
    this.cacheErrorListeners.add(listener);
    return () => this.cacheErrorListeners.delete(listener);
  }
  /** @internal */
  notifyCacheError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.cacheErrorListeners) listener(normalized);
  }
  /** @internal */
  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (this.requestNamespace) headers.set("x-armadillo-app-id", this.requestNamespace);
    if (this.registeredAppId) headers.set("x-armadillo-client-app-id", this.registeredAppId);
    if (this.clientKey) headers.set("x-armadillo-client-key", this.clientKey);
    const token = options.auth?.token ?? this.authToken;
    if (token) headers.set("authorization", `Bearer ${token}`);
    let body;
    if (options.body !== void 0) {
      if (isBody(options.body)) {
        body = options.body;
      } else {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
      }
    }
    const response = await this.fetcher(`${this.url}${path}`, {
      method: options.method ?? (body === void 0 ? "GET" : "POST"),
      headers,
      credentials: "include",
      ...body === void 0 ? {} : { body }
    });
    if (!response.ok) {
      let envelope = {};
      try {
        envelope = await response.json();
      } catch {
      }
      const error = envelope.error;
      const requestId = error?.requestId ?? response.headers.get("x-request-id") ?? void 0;
      throw new ArmadilloError(error?.message ?? `Request failed (${response.status}).`, {
        code: error?.code ?? "INTERNAL_ERROR",
        status: response.status,
        ...error?.fields ? { fields: error.fields } : {},
        ...error?.hint ? { hint: error.hint } : {},
        ...requestId ? { requestId } : {}
      });
    }
    if (options.raw) return response;
    if (response.status === 204) return void 0;
    return await response.json();
  }
  /** @internal Fetch a presigned provider URL without Dillo auth headers. */
  async fetchExternal(input, init) {
    return this.fetcher(input, init);
  }
}
function createArmadillo(options) {
  return new ArmadilloClient(options);
}
createArmadillo.prototype = ArmadilloClient.prototype;
createArmadillo.client = createArmadillo;
const Armadillo = createArmadillo;
const armadillo = Armadillo;
class GroupsClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async list() {
    return (await this.app.request(`${HTTP_API_PREFIX}/groups`)).groups;
  }
  async create(input) {
    return (await this.app.request(`${HTTP_API_PREFIX}/groups`, {
      method: "POST",
      body: input
    })).group;
  }
  async createTrusted(input, adminKey) {
    return (await this.app.request(`${HTTP_API_PREFIX}/admin/groups`, {
      method: "POST",
      headers: { "x-armadillo-admin-key": adminKey },
      body: input
    })).group;
  }
  async members(groupId) {
    return (await this.app.request(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members`
    )).members;
  }
  async addMember(groupId, input) {
    return (await this.app.request(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members`,
      { method: "POST", body: input }
    )).member;
  }
  async removeMember(groupId, userId) {
    await this.app.request(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
  }
  /**
   * Hand team ownership to a current member. Only the owner may call it;
   * the previous owner steps down to admin. Both updates commit atomically.
   */
  async transferOwnership(groupId, input) {
    return this.app.request(
      `${HTTP_API_PREFIX}/groups/${encodeURIComponent(groupId)}/transfer`,
      { method: "POST", body: input }
    );
  }
}
class EventsClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async list(options = {}) {
    const parameters = new URLSearchParams();
    if (options.after) parameters.set("after", options.after);
    if (options.limit !== void 0) parameters.set("limit", String(options.limit));
    const query = parameters.size > 0 ? `?${parameters}` : "";
    return (await this.app.request(
      `${HTTP_API_PREFIX}/events${query}`
    )).events;
  }
}
class AuthClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async signUp(input, options) {
    const result = await this.app.request(`${HTTP_API_PREFIX}/auth/signup`, {
      method: "POST",
      body: input,
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" }
    });
    return this.acceptSession(result, options);
  }
  async logIn(input, options) {
    const result = await this.app.request(`${HTTP_API_PREFIX}/auth/login`, {
      method: "POST",
      body: input,
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" }
    });
    return this.acceptSession(result, options);
  }
  acceptSession(result, options) {
    if (options?.mode === "token") {
      if (!result.token || !result.expiresAt) throw new ArmadilloError("The backend did not issue a token session.", {
        code: "INTERNAL_ERROR",
        status: 500
      });
      return { user: result.user, token: result.token, expiresAt: result.expiresAt };
    }
    this.app.notifyAuth(result.user);
    return result.user;
  }
  async requestMagicLink(input) {
    return this.app.request(`${HTTP_API_PREFIX}/auth/magic-link`, {
      method: "POST",
      body: input
    });
  }
  async verifyMagicLink(token, options) {
    const result = await this.app.request(`${HTTP_API_PREFIX}/auth/verify`, {
      method: "POST",
      body: { token },
      headers: { "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" }
    });
    return this.acceptSession(result, options);
  }
  async bootstrap(input, options) {
    const result = await this.app.request(`${HTTP_API_PREFIX}/admin/bootstrap`, {
      method: "POST",
      body: input,
      headers: { "x-armadillo-bootstrap-secret": input.secret, "x-armadillo-auth-mode": options?.mode === "token" ? "token" : "cookie" }
    });
    return this.acceptSession(result, options);
  }
  async logOut() {
    try {
      await this.app.request(`${HTTP_API_PREFIX}/auth/logout`, { method: "POST" });
    } catch (error) {
      if (!(error instanceof ArmadilloError && error.code === "UNAUTHENTICATED")) throw error;
    } finally {
      this.app.notifyAuth(null);
    }
  }
  async changePassword(input) {
    await this.app.request(`${HTTP_API_PREFIX}/auth/password`, {
      method: "POST",
      body: input
    });
  }
  async currentUser() {
    try {
      const result = await this.app.request(`${HTTP_API_PREFIX}/auth/me`);
      return result.user;
    } catch (error) {
      if (error instanceof ArmadilloError && error.code === "UNAUTHENTICATED") {
        this.app.notifyAuth(null);
        return null;
      }
      throw error;
    }
  }
  onChange(listener) {
    return this.app.subscribeAuth(listener);
  }
}
const FORBIDDEN_ASSIGN_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function assignOwnData(target, source) {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(target, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
}
function hydrate(table, raw) {
  const record = { ...raw };
  let generation = 0;
  Object.defineProperties(record, {
    files: {
      enumerable: false,
      value: table.files(raw.id)
    },
    expand: {
      enumerable: false,
      value: (path) => table.expandRecord(raw.id, path)
    },
    update: {
      enumerable: false,
      value: async (changes, options = {}) => {
        if (options.optimistic) {
          const previousProto = Object.getPrototypeOf(record);
          generation += 1;
          const attempt = generation;
          const present = /* @__PURE__ */ new Set();
          const previous = {};
          for (const key of Object.keys(changes)) {
            if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
            if (Object.hasOwn(record, key)) {
              present.add(key);
              previous[key] = record[key];
            }
          }
          assignOwnData(record, changes);
          table.invalidateQueries();
          void table.update(raw.id, changes).then((updated2) => {
            if (attempt !== generation) return;
            assignOwnData(record, updated2);
          }).catch((error) => {
            if (attempt !== generation) return;
            for (const key of Object.keys(changes)) {
              if (FORBIDDEN_ASSIGN_KEYS.has(key)) continue;
              if (present.has(key)) {
                Object.defineProperty(record, key, {
                  value: previous[key],
                  enumerable: true,
                  writable: true,
                  configurable: true
                });
              } else {
                delete record[key];
              }
            }
            Object.setPrototypeOf(record, previousProto);
            table.notifyCacheError(error);
          });
          return record;
        }
        const updated = await table.update(raw.id, changes);
        generation += 1;
        assignOwnData(record, updated);
        return record;
      }
    },
    delete: {
      enumerable: false,
      value: () => table.delete(raw.id)
    },
    toJSON: {
      enumerable: false,
      value: () => ({ ...record })
    }
  });
  return record;
}
const WHERE_SYSTEM_FIELDS = /* @__PURE__ */ new Set(["id", "ownerId", "createdAt", "updatedAt"]);
const INCLUDE_DEPTH_MESSAGE = "Includes go 3 deep. Need more? Pluck it out and .expand() it.";
class Table {
  constructor(app, name, fieldNames) {
    this.app = app;
    this.fieldNames = fieldNames;
    this.name = name;
    this.tickets = {
      issue: (recordId, options = {}) => this.app.request(
        `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/tickets/issue`,
        { method: "POST", body: { recordId }, ...options }
      ),
      consume: (token, options = {}) => this.app.request(
        `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/tickets/consume`,
        { method: "POST", body: { token }, ...options }
      )
    };
  }
  app;
  fieldNames;
  name;
  /** Inventory tokens for this table's tickets field. Not `app.tickets`. */
  tickets;
  async create(data, options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}`,
      { method: "POST", body: { data }, ...options }
    );
    this.invalidateQueries();
    return hydrate(this, result.object);
  }
  async createMany(items, options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}`,
      { method: "POST", body: { data: items }, ...options }
    );
    this.invalidateQueries();
    return result.objects.map((raw) => hydrate(this, raw));
  }
  async get(id, options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      options
    );
    return hydrate(this, result.object);
  }
  async update(id, changes, options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      { method: "PATCH", body: { data: changes }, ...options }
    );
    this.invalidateQueries();
    return hydrate(this, result.object);
  }
  async delete(id, options = {}) {
    await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      { method: "DELETE", ...options }
    );
    this.invalidateQueries();
  }
  query() {
    return new Query(this.app, this);
  }
  /**
   * Sugar for `query().where(...).include(...).limit(...).find()`.
   * `where` keys are fields on this table only.
   */
  async find(options = {}) {
    const query = this.query();
    if (options.where) query.where(options.where);
    if (options.include !== void 0) query.include(options.include);
    if (options.limit !== void 0) query.limit(options.limit);
    return query.find();
  }
  subscribe(options) {
    return this.app.realtime.subscribe({
      channel: `table:${this.name}`,
      ...options.where ? { where: options.where } : {},
      onChange: (event) => {
        const record = event.record && typeof event.record === "object" && "id" in event.record ? this.hydrate(event.record) : event.record;
        options.onChange({ ...event, record });
      }
    });
  }
  files(id) {
    return new RecordFilesClient(this.app, this.name, id);
  }
  /** @internal */
  hydrate(raw) {
    return hydrate(this, raw);
  }
  /** @internal */
  async expandRecord(id, path) {
    const segments = path.split(".");
    if (segments.length > 8) {
      throw new ArmadilloError("expand() accepts at most 8 segments.", { code: "BAD_REQUEST", status: 400 });
    }
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}/expand`,
      { method: "POST", body: { path } }
    );
    const value = result.value;
    if (!value || typeof value !== "object") return value;
    if (!result.collection || result.collection === "_User" || result.collection === "_Team") return value;
    if (typeof value.id !== "string") return value;
    return new Table(this.app, result.collection).hydrate(value);
  }
  /** @internal */
  rejectForeignWhere(field) {
    if (!this.fieldNames) return;
    const dot = field.indexOf(".");
    const root = dot === -1 ? field : field.slice(0, dot);
    if (dot === -1 && (this.fieldNames.has(field) || WHERE_SYSTEM_FIELDS.has(field))) return;
    if (dot !== -1 && root && this.fieldNames.has(root)) return;
    throw new ArmadilloError(
      `where field \`${field}\` is not on ${this.name}. where does not walk onto an included table.`,
      { code: "BAD_REQUEST", status: 400 }
    );
  }
  /** @internal */
  invalidateQueries() {
    this.app.cache.invalidate(this.name);
  }
  /** @internal */
  notifyCacheError(error) {
    this.app.notifyCacheError(error);
  }
}
function unsupportedExpandOption(key) {
  return `expand(field, { ${key} }) is not supported. An include takes no options: it returns up to 100 rows per parent, ordered by id. Query that table on its own for a limit or an order.`;
}
function assertExpandOptions(options) {
  for (const key of Object.keys(options)) {
    if (key === "expand") continue;
    throw new ArmadilloError(unsupportedExpandOption(key), { code: "BAD_REQUEST", status: 400 });
  }
}
function isIncludeRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compileInclude(value, depth) {
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
class Query {
  constructor(app, table) {
    this.app = app;
    this.table = table;
  }
  app;
  table;
  filters = [];
  ordering = [];
  maximum = 100;
  offset = 0;
  limitTouched = false;
  expands = [];
  nearConstraints = [];
  boundingBoxes = [];
  spatialOrder;
  includeDistance;
  where(fieldOrFields, value) {
    if (typeof fieldOrFields === "string") {
      if (value === void 0) throw new TypeError("where(field, value) requires a value.");
      return this.addFilter(fieldOrFields, "eq", value);
    }
    for (const [field, fieldValue] of Object.entries(fieldOrFields)) {
      if (fieldValue !== void 0) this.addFilter(field, "eq", fieldValue);
    }
    return this;
  }
  equalTo(field, value) {
    return this.addFilter(field, "eq", value);
  }
  /** Match a primitive at a bounded object path within a declared JSON field. */
  whereJsonPath(field, path, value) {
    return this.addFilter(`${field}.${path}`, "eq", value);
  }
  notEqualTo(field, value) {
    return this.addFilter(field, "ne", value);
  }
  lessThan(field, value) {
    return this.addFilter(field, "lt", value);
  }
  lessThanOrEqualTo(field, value) {
    return this.addFilter(field, "lte", value);
  }
  greaterThan(field, value) {
    return this.addFilter(field, "gt", value);
  }
  greaterThanOrEqualTo(field, value) {
    return this.addFilter(field, "gte", value);
  }
  containedIn(field, values) {
    return this.addFilter(field, "in", values);
  }
  contains(field, value) {
    return this.addFilter(field, "contains", value);
  }
  orderBy(field, direction = "asc") {
    if (typeof direction === "object") {
      const center = direction.nearest ?? direction.farthest;
      if (center) {
        assertGeoPoint(center);
        this.spatialOrder = {
          field,
          center,
          direction: direction.farthest ? "farthest" : "nearest"
        };
        return this;
      }
      this.ordering.push({ field, direction: direction.descending ? "desc" : "asc" });
      return this;
    }
    this.ordering.push({ field, direction });
    return this;
  }
  ascending(field) {
    return this.orderBy(field, "asc");
  }
  descending(field) {
    return this.orderBy(field, "desc");
  }
  limit(maximum) {
    this.maximum = maximum;
    this.limitTouched = true;
    return this;
  }
  skip(offset) {
    this.offset = offset;
    return this;
  }
  expand(field, options = {}) {
    assertExpandOptions(options);
    this.expands.push({
      field,
      ...options.expand ? { expand: typeof options.expand === "string" ? [options.expand] : [...options.expand] } : {}
    });
    return this;
  }
  /** Tree include. Depth 4 throws before the request. Sends the same expands payload as expand(). */
  include(spec) {
    for (const entry of compileInclude(spec, 1)) this.expands.push(entry);
    return this;
  }
  near(field, options) {
    assertGeoPoint(options.center);
    distanceInMeters(options.radius, options.unit);
    this.nearConstraints.push({
      field,
      center: options.center,
      radius: options.radius,
      unit: options.unit ?? "meters"
    });
    return this;
  }
  withinBoundingBox(field, bounds) {
    assertGeoPoint(bounds.northEast);
    assertGeoPoint(bounds.southWest);
    if (bounds.northEast.latitude < bounds.southWest.latitude) {
      throw new TypeError("Bounding-box northEast latitude must be north of southWest.");
    }
    this.boundingBoxes.push({ field, ...bounds });
    return this;
  }
  select(options) {
    this.includeDistance = options.includeDistance;
    return this;
  }
  async find(options = {}) {
    if (!this.limitTouched) {
      return this.findEveryPage(options);
    }
    const payload = this.payload(false);
    const key = queryCacheKey(this.table.name, payload);
    const cached = options.auth ? void 0 : this.app.cache.get(key);
    if (this.app.cache.strategy === "cache-first" && cached && !cached.stale) {
      return cached.value.map((raw) => this.table.hydrate(raw));
    }
    if (this.app.cache.strategy === "stale-while-revalidate" && cached) {
      if (cached.stale) void this.fetchAndCache(key, payload, options).catch((error) => this.app.notifyCacheError(error));
      return cached.value.map((raw) => this.table.hydrate(raw));
    }
    const results = await this.fetchAndCache(key, payload, options);
    return results.map((raw) => this.table.hydrate(raw));
  }
  /**
   * Page an untouched find() with skip until a short page. Page size 100 is internal.
   *
   * The assembled result is cached under the untouched-query key, because that
   * is the shape `table("X").query().find()` — the most common call there is —
   * takes. Without this, `cache-first` never served a hit for it and every read
   * went to the network, which is the opposite of what the strategy promises.
   */
  async findEveryPage(options = {}) {
    const key = queryCacheKey(this.table.name, this.payload(false));
    const revision = this.app.cache.revision;
    if (!options.auth && this.app.cache.strategy !== "network-only") {
      const cached = this.app.cache.get(key);
      if (cached && (this.app.cache.strategy === "cache-first" ? !cached.stale : true)) {
        if (cached.stale) {
          void this.findEveryPageInto(key, options).catch((error) => this.app.notifyCacheError(error));
        }
        return cached.value.map((raw) => this.table.hydrate(raw));
      }
    }
    return this.findEveryPageInto(key, options, revision);
  }
  async findEveryPageInto(key, options = {}, revision = this.app.cache.revision) {
    const pageSize = 100;
    const serverSkipMax = 1e4;
    const rows = [];
    let skip = this.offset;
    for (; ; ) {
      const payload = { ...this.payload(false), limit: pageSize, skip };
      const page = await this.app.request(
        `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
        { method: "POST", body: payload, ...options }
      );
      rows.push(...page.results);
      if (page.results.length < pageSize) break;
      const nextSkip = skip + pageSize;
      if (nextSkip > serverSkipMax) {
        const total = await this.count(options);
        if (total > rows.length) {
          throw new ArmadilloError(
            `Query result exceeds the server skip window (${serverSkipMax}). Narrow the query or page explicitly with limit() and skip().`,
            { code: "BAD_REQUEST", status: 400 }
          );
        }
        break;
      }
      skip = nextSkip;
    }
    if (!options.auth && this.app.cache.strategy !== "network-only" && revision === this.app.cache.revision) {
      this.app.cache.set(key, this.table.name, rows);
    }
    return rows.map((raw) => this.table.hydrate(raw));
  }
  async fetchAndCache(key, payload, options = {}) {
    const revision = this.app.cache.revision;
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
      { method: "POST", body: payload, ...options }
    );
    if (!options.auth && this.app.cache.strategy !== "network-only" && revision === this.app.cache.revision) {
      this.app.cache.set(key, this.table.name, result.results);
    }
    return result.results;
  }
  async first(options = {}) {
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
  async count(options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/query/${encodeURIComponent(this.table.name)}`,
      { method: "POST", body: this.payload(true), ...options }
    );
    return result.count;
  }
  addFilter(field, operator, value) {
    this.table.rejectForeignWhere(field);
    this.filters.push({ field, operator, value });
    return this;
  }
  payload(count) {
    return {
      filters: this.filters,
      order: this.ordering,
      limit: this.maximum,
      skip: this.offset,
      count,
      ...this.expands.length > 0 ? { expands: this.expands } : {},
      ...this.nearConstraints.length > 0 ? { near: this.nearConstraints } : {},
      ...this.boundingBoxes.length > 0 ? { boundingBoxes: this.boundingBoxes } : {},
      ...this.spatialOrder ? { spatialOrder: this.spatialOrder } : {},
      ...this.includeDistance ? { includeDistance: this.includeDistance } : {}
    };
  }
}
function hydrateFile(files, raw) {
  const file = { ...raw };
  Object.defineProperties(file, {
    download: {
      enumerable: false,
      value: () => files.download(raw.id)
    },
    url: {
      enumerable: false,
      value: () => files.url(raw.id)
    },
    delete: {
      enumerable: false,
      value: () => files.delete(raw.id)
    }
  });
  return file;
}
class FilesClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async upload(blob, options = {}) {
    const mode = options.mode ?? "auto";
    if (mode === "direct") return this.uploadDirect(blob, options);
    if (mode === "multipart" || mode === "auto" && blob.size > 100 * 1024 * 1024) {
      return this.uploadMultipart(blob, options);
    }
    const candidateName = blob.name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const result = await this.app.request(`${HTTP_API_PREFIX}/files`, {
      method: "POST",
      body: blob,
      headers: {
        "content-type": contentType,
        "x-armadillo-file-name": encodeURIComponent(name)
      },
      ...options
    });
    return hydrateFile(this, result.file);
  }
  async uploadDirect(blob, options = {}) {
    const candidateName = blob.name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const intent = await this.app.request(`${HTTP_API_PREFIX}/files/presign`, {
      method: "POST",
      body: { name, contentType, size: blob.size },
      ...options.auth ? { auth: options.auth } : {}
    });
    const uploaded = await this.app.fetchExternal(intent.upload.uploadUrl, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: blob
    });
    if (!uploaded.ok) {
      throw new ArmadilloError(`Direct object upload failed (${uploaded.status}).`, {
        code: "INTERNAL_ERROR",
        status: uploaded.status
      });
    }
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/files/uploads/${encodeURIComponent(intent.upload.id)}/complete`,
      { method: "POST", body: {}, ...options.auth ? { auth: options.auth } : {} }
    );
    return hydrateFile(this, result.file);
  }
  async uploadMultipart(blob, options = {}) {
    const candidateName = blob.name;
    const name = options.name ?? (typeof candidateName === "string" ? candidateName : "file");
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    const intent = await this.app.request(`${HTTP_API_PREFIX}/files/multipart`, {
      method: "POST",
      body: { name, contentType, size: blob.size },
      ...options.auth ? { auth: options.auth } : {}
    });
    const partCount = Math.max(1, Math.ceil(blob.size / intent.upload.partSize));
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1;
      const chunk = blob.slice(index * intent.upload.partSize, Math.min(blob.size, partNumber * intent.upload.partSize));
      const result2 = await this.app.request(
        `${HTTP_API_PREFIX}/files/multipart/${encodeURIComponent(intent.upload.id)}/parts/${partNumber}`,
        { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream" }, ...options.auth ? { auth: options.auth } : {} }
      );
      return result2.part;
    }));
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/files/multipart/${encodeURIComponent(intent.upload.id)}/complete`,
      { method: "POST", body: { parts }, ...options.auth ? { auth: options.auth } : {} }
    );
    return hydrateFile(this, result.file);
  }
  async get(id, options = {}) {
    const result = await this.app.request(
      `${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}/meta`,
      options
    );
    return hydrateFile(this, result.file);
  }
  async list(options = {}) {
    const rows = [];
    let cursor = null;
    do {
      const page = await this.listPage({ ...options, ...cursor ? { cursor } : {} });
      rows.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  async listPage(options = {}) {
    const parameters = new URLSearchParams();
    if (options.limit !== void 0) parameters.set("limit", String(options.limit));
    if (options.cursor) parameters.set("cursor", options.cursor);
    const query = parameters.size ? `?${parameters}` : "";
    const result = await this.app.request(`${HTTP_API_PREFIX}/files${query}`, options);
    return { files: result.files.map((file) => hydrateFile(this, file)), nextCursor: result.nextCursor };
  }
  async download(id, options = {}) {
    const response = await this.app.request(
      `${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}`,
      { raw: true, ...options }
    );
    return response.blob();
  }
  async url(id, options = {}) {
    return (await this.app.request(`${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}/url`, options)).url;
  }
  async delete(id, options = {}) {
    await this.app.request(`${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...options
    });
  }
}
class RecordFilesClient {
  constructor(app, table, objectId) {
    this.app = app;
    this.table = table;
    this.objectId = objectId;
  }
  app;
  table;
  objectId;
  path(fileId) {
    const base = `${HTTP_API_PREFIX}/tables/${encodeURIComponent(this.table)}/${encodeURIComponent(this.objectId)}/files`;
    return fileId ? `${base}/${encodeURIComponent(fileId)}` : base;
  }
  async list() {
    const result = await this.app.request(this.path());
    return result.files.map((file) => hydrateFile(this.app.files, file));
  }
  async attach(file, position = 0) {
    const fileId = typeof file === "string" ? file : file.id;
    const result = await this.app.request(this.path(), {
      method: "POST",
      body: { fileId, position }
    });
    return hydrateFile(this.app.files, result.file);
  }
  async upload(blob, options = {}) {
    const file = await this.app.files.upload(blob, options);
    await this.attach(file);
    return file;
  }
  async detach(file) {
    await this.app.request(this.path(typeof file === "string" ? file : file.id), { method: "DELETE" });
  }
}
class ApiKeysClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async list() {
    const rows = [];
    let cursor = null;
    do {
      const route = cursor ? `${HTTP_API_PREFIX}/api-keys?cursor=${encodeURIComponent(cursor)}` : `${HTTP_API_PREFIX}/api-keys`;
      const page = await this.app.request(route);
      rows.push(...page.apiKeys);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
  async create(input) {
    return this.app.request(`${HTTP_API_PREFIX}/api-keys`, { method: "POST", body: input });
  }
  async get(id) {
    return (await this.app.request(
      `${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`
    )).apiKey;
  }
  async update(id, input) {
    return (await this.app.request(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input
    })).apiKey;
  }
  async rotate(id, options = {}) {
    return this.app.request(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}/rotate`, {
      method: "POST",
      body: options
    });
  }
  async audit(id) {
    const rows = [];
    let cursor = null;
    const key = encodeURIComponent(id);
    do {
      const route = cursor ? `${HTTP_API_PREFIX}/api-keys/${key}/audit?cursor=${encodeURIComponent(cursor)}` : `${HTTP_API_PREFIX}/api-keys/${key}/audit`;
      const page = await this.app.request(route);
      rows.push(...page.audit);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
  async revoke(id) {
    await this.app.request(`${HTTP_API_PREFIX}/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
class VouchersClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async list() {
    const rows = [];
    let cursor = null;
    do {
      const route = cursor ? `${HTTP_API_PREFIX}/vouchers?cursor=${encodeURIComponent(cursor)}` : `${HTTP_API_PREFIX}/vouchers`;
      const page = await this.app.request(route);
      rows.push(...page.vouchers);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
  async get(id) {
    return (await this.app.request(`${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}`)).voucher;
  }
  async create(input) {
    return this.app.request(`${HTTP_API_PREFIX}/vouchers`, { method: "POST", body: input });
  }
  async consume(code, idempotencyKey) {
    return this.app.request(`${HTTP_API_PREFIX}/vouchers/consume`, {
      method: "POST",
      body: { code, idempotencyKey }
    });
  }
  async restock(id, amount = 1) {
    return (await this.app.request(
      `${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}/restock`,
      { method: "POST", body: { amount } }
    )).voucher;
  }
  async expire(id) {
    await this.app.request(`${HTTP_API_PREFIX}/vouchers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
class Ticket {
  constructor(client, code, value) {
    this.client = client;
    this.code = code;
    this.value = value;
  }
  client;
  code;
  value;
  get id() {
    return this.value.id;
  }
  get label() {
    return this.value.label;
  }
  get status() {
    return this.value.status;
  }
  get consumedAt() {
    return this.value.consumedAt;
  }
  get consumedBy() {
    return this.value.consumedBy;
  }
  toJSON() {
    return { ...this.value, metadata: { ...this.value.metadata } };
  }
  async consume(idempotencyKey = crypto.randomUUID()) {
    const result = await this.client.consume(this.code, idempotencyKey);
    this.value = result.ticket;
    return { consumed: true, idempotent: result.idempotent, ticket: this };
  }
}
class TicketsClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async list() {
    const rows = [];
    let cursor = null;
    do {
      const route = cursor ? `${HTTP_API_PREFIX}/tickets?cursor=${encodeURIComponent(cursor)}` : `${HTTP_API_PREFIX}/tickets`;
      const page = await this.app.request(route);
      rows.push(...page.tickets);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
  async get(id) {
    return (await this.app.request(`${HTTP_API_PREFIX}/tickets/${encodeURIComponent(id)}`)).ticket;
  }
  async issue(input) {
    return this.app.request(`${HTTP_API_PREFIX}/tickets`, { method: "POST", body: input });
  }
  async lookup(code) {
    const result = await this.app.request(`${HTTP_API_PREFIX}/tickets/lookup`, {
      method: "POST",
      body: { code }
    });
    return new Ticket(this, code, result.ticket);
  }
  /** @internal Prefer lookup(code).consume() in application UI. */
  async consume(code, idempotencyKey) {
    return this.app.request(`${HTTP_API_PREFIX}/tickets/consume`, {
      method: "POST",
      body: { code, idempotencyKey }
    });
  }
}
class CollectorClient {
  constructor(app, id) {
    this.app = app;
    this.id = id;
  }
  app;
  id;
  async submit(data) {
    return (await this.app.request(
      `${HTTP_API_PREFIX}/collectors/${encodeURIComponent(this.id)}`,
      { method: "POST", body: { data } }
    )).submission;
  }
  async submissions() {
    const rows = [];
    let cursor = null;
    const collector = encodeURIComponent(this.id);
    do {
      const route = cursor ? `${HTTP_API_PREFIX}/collectors/${collector}/submissions?cursor=${encodeURIComponent(cursor)}` : `${HTTP_API_PREFIX}/collectors/${collector}/submissions`;
      const page = await this.app.request(route);
      rows.push(...page.submissions);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }
}
class CollectorsClient {
  constructor(app) {
    this.app = app;
  }
  app;
  get(id) {
    return new CollectorClient(this.app, id);
  }
}
class AppsClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async current() {
    return (await this.app.request(`${HTTP_API_PREFIX}/apps/current`)).app;
  }
  async list() {
    return (await this.app.request(`${HTTP_API_PREFIX}/apps`)).apps;
  }
}
class GdprClient {
  constructor(app) {
    this.app = app;
  }
  app;
  async info() {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/info`)).info;
  }
  async consents() {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/consents`)).consents;
  }
  async consent(input) {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/consent`, {
      method: "POST",
      body: input
    })).consent;
  }
  async export() {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/export`, { method: "POST", body: {} })).bundle;
  }
  async rectify(input) {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/rectify`, {
      method: "POST",
      body: input
    })).user;
  }
  async restrict(input) {
    return this.app.request(`${HTTP_API_PREFIX}/gdpr/restrict`, { method: "POST", body: input });
  }
  async erase(input) {
    return this.app.request(`${HTTP_API_PREFIX}/gdpr/erase`, { method: "POST", body: input });
  }
  async erasureLog() {
    return (await this.app.request(`${HTTP_API_PREFIX}/gdpr/erasure-log`)).log;
  }
}
export {
  ApiKeysClient,
  AppsClient,
  Armadillo,
  ArmadilloClient,
  ArmadilloError,
  AuthClient,
  CollectorClient,
  CollectorsClient,
  EventsClient,
  FilesClient,
  GdprClient,
  GroupsClient,
  Query,
  RecordFilesClient,
  Table,
  Ticket,
  TicketsClient,
  VouchersClient,
  armadillo
};
