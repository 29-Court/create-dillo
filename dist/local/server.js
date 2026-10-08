import { HTTP_API_PREFIX } from "../versions.js";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer
} from "node:http";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRuntimeEnvironment } from "../engine/runtime.js";
import { handleRequest } from "../engine/engine.js";
import { passwordHash } from "../engine/helpers/crypto.js";
import { runScheduledSweep } from "../engine/maintenance.js";
import { LocalSqliteDatabase } from "./sqlite.js";
import { LocalFileStorage } from "./storage.js";
import { isReservedFrameworkPath } from "../ui.js";
import {
  createLocalAgentBridgeStore,
  handleAgentBridgeLocalRequest,
  resolveOwnerIdFromSqliteSession,
  MemoryAgentBridgeStore
} from "../agent-bridge/index.js";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};
function extension(pathname) {
  const index = pathname.lastIndexOf(".");
  return index < 0 ? "" : pathname.slice(index).toLowerCase();
}
function requestFromNode(request) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value) headers.append(name, value);
  }
  headers.set("cf-connecting-ip", request.socket.remoteAddress ?? "unknown");
  headers.delete("x-forwarded-for");
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${headers.get("host") ?? "localhost"}`);
  const hasBody = method !== "GET" && method !== "HEAD";
  const init = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(url, init);
}
async function sendResponse(response, output) {
  output.statusCode = response.status;
  output.statusMessage = response.statusText;
  response.headers.forEach((value, name) => output.setHeader(name, value));
  if (!response.body) {
    output.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body),
    output
  );
}
function errorResponse(error) {
  console.error(error);
  return Response.json({ error: "INTERNAL_ERROR", message: "The local server could not handle the request." }, {
    status: 500
  });
}
function isClientDisconnect(error, output) {
  if (output.destroyed || output.closed) return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ECONNRESET" || error.code === "EPIPE" || error.code === "ERR_STREAM_PREMATURE_CLOSE";
}
const internalTables = {
  bootstrap: "_armadillo_bootstrap",
  groupMembers: "_armadillo_group_members",
  groups: "_armadillo_groups",
  sessions: "_armadillo_sessions",
  users: "_armadillo_users"
};
function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
const LOCAL_REQUEST_TIMEOUT_MS = 12e4;
const LOCAL_HEADERS_TIMEOUT_MS = 3e4;
const LOCAL_KEEPALIVE_TIMEOUT_MS = 1e4;
const LOCAL_MAX_CONNECTIONS = 256;
function validateDevelopmentAdmin(admin) {
  if (!admin.email.includes("@") || admin.email.length > 320) {
    throw new Error("developmentAdmin.email must be a valid email address.");
  }
  if (admin.password.length < 10 || admin.password.length > 1024) {
    throw new Error("developmentAdmin.password must be between 10 and 1024 characters.");
  }
  if (admin.name !== void 0 && admin.name.length > 160) {
    throw new Error("developmentAdmin.name must be at most 160 characters.");
  }
}
class LocalArmadilloServer {
  constructor(backend, options) {
    this.backend = backend;
    this.appId = options.appId;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.port = options.port ?? 8787;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 15 * 60 * 1e3;
    if (options.developmentAdmin) {
      if (!options.development || process.env.NODE_ENV === "production" || !isLoopbackHost(this.hostname)) {
        throw new Error("developmentAdmin requires a loopback server running in development mode.");
      }
      validateDevelopmentAdmin(options.developmentAdmin);
      this.developmentAdmin = options.developmentAdmin;
    }
    this.publicDirectory = options.publicDirectory ? resolve(options.publicDirectory) : void 0;
    this.requestHandler = options.requestHandler;
    if (options.development) {
      if (process.env.NODE_ENV === "production" || !isLoopbackHost(this.hostname)) {
        throw new Error("development mode requires a loopback server running outside production.");
      }
      this.agentBridgeStore = createLocalAgentBridgeStore();
    }
    this.database = new LocalSqliteDatabase(options.databasePath, {
      appId: options.appId,
      ...backend.schema ? { schema: backend.schema } : {},
      ...options.migrationFiles ? { migrationFiles: options.migrationFiles } : {},
      ...options.allowUnsafeSchemaChanges === void 0 ? {} : { allowUnsafeSchemaChanges: options.allowUnsafeSchemaChanges }
    });
    this.files = new LocalFileStorage(options.filesDirectory);
    const { ARMADILLO_REALTIME, ARMADILLO_FILE_URLS, ...bindings } = options.bindings ?? {};
    try {
      this.env = createRuntimeEnvironment({
        appId: options.appId,
        backend,
        database: this.database,
        storage: this.files,
        ...ARMADILLO_REALTIME ? { realtime: ARMADILLO_REALTIME } : {},
        ...ARMADILLO_FILE_URLS ? { fileUrls: ARMADILLO_FILE_URLS } : {},
        stage: options.stage ?? "local",
        signup: options.signupMode ?? "closed",
        corsOrigin: options.corsOrigin ?? "*",
        bindings: Object.fromEntries(Object.entries({
          ARMADILLO_BOOTSTRAP_SECRET: options.bootstrapSecret,
          ARMADILLO_ADMIN_KEY: options.adminKey,
          ARMADILLO_SUPERADMIN_GROUP: options.superadminGroup,
          ARMADILLO_ALLOW_CLIENT_APP_ID: options.allowClientAppId ? "1" : void 0,
          ARMADILLO_TRUST_FORWARDED_IP: options.trustForwardedIp ? "1" : void 0,
          ARMADILLO_DEV_MODE: options.development ? "1" : void 0,
          // `development` is already refused unless the host is loopback and
          // NODE_ENV is not production (see the constructor), which is the
          // precondition for handing out a live sign-in token in a response.
          ARMADILLO_EXPOSE_DEBUG_TOKENS: options.development ? "1" : void 0,
          ARMADILLO_SQL_DIALECT: "sqlite",
          ARMADILLO_STORAGE_LABELS: ["SQLite", ...backend.files !== false ? ["local filesystem"] : []],
          ARMADILLO_PURPOSE: "Self-hosted Armadillo on Node.js, SQLite, and local file storage.",
          ARMADILLO_MAX_JSON_BYTES: options.maxJsonBytes === void 0 ? void 0 : String(options.maxJsonBytes),
          ARMADILLO_MAX_FILE_BYTES: options.maxFileBytes === void 0 ? void 0 : String(options.maxFileBytes),
          ...bindings
        }).filter(([, value]) => value !== void 0))
      });
    } catch (error) {
      void this.database.close();
      throw error;
    }
  }
  backend;
  database;
  files;
  env;
  publicDirectory;
  hostname;
  port;
  maintenanceIntervalMs;
  appId;
  developmentAdmin;
  requestHandler;
  /** DEV-only in-memory Agent Bridge store; undefined outside development. */
  agentBridgeStore;
  server;
  maintenance;
  currentOrigin;
  get resources() {
    return this.env.resources;
  }
  get origin() {
    if (!this.currentOrigin) throw new Error("The local server is not listening yet.");
    return this.currentOrigin;
  }
  async staticResponse(request) {
    if (!this.publicDirectory || request.method !== "GET" && request.method !== "HEAD") return void 0;
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Malformed path", { status: 400 });
    }
    if (pathname.includes("\0")) return new Response("Malformed path", { status: 400 });
    if (isReservedFrameworkPath(pathname)) return void 0;
    if (Object.values(this.backend.ui?.apps ?? {}).some((app) => app.path === pathname)) return void 0;
    let relative = pathname.replace(/^\/+/, "");
    if (!relative || relative.endsWith("/")) relative += "index.html";
    if (relative.split("/").includes("..")) return new Response("Forbidden", { status: 403 });
    const candidate = resolve(this.publicDirectory, relative);
    if (candidate !== this.publicDirectory && !candidate.startsWith(`${this.publicDirectory}${sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const info = await stat(candidate);
      if (!info.isFile()) return void 0;
      const etag = `W/"${createHash("sha256").update(`${info.size}:${info.mtimeMs}`).digest("base64url")}"`;
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      const headers = new Headers({
        "cache-control": extension(candidate) === ".html" ? "no-cache" : "public, max-age=3600",
        "content-length": String(info.size),
        "content-type": contentTypes[extension(candidate)] ?? "application/octet-stream",
        etag,
        "x-content-type-options": "nosniff"
      });
      const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(candidate));
      return new Response(body, { headers });
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENAMETOOLONG")) return void 0;
      throw error;
    }
  }
  /**
   * Handle one request through the full local pipeline (static files,
   * request handler, engine) without listening on a socket. Tests and tools
   * can drive a server in-process by passing this as a fetch implementation.
   */
  async handle(request) {
    const staticResponse = await this.staticResponse(request);
    if (staticResponse) return staticResponse;
    const bridgeResponse = await this.dispatchAgentBridge(request);
    if (bridgeResponse) return bridgeResponse;
    const applicationResponse = await this.requestHandler?.(request, {
      database: this.database,
      files: this.files,
      bindings: this.env
    });
    return applicationResponse ?? handleRequest(request, this.env, this.backend);
  }
  /**
   * Mount Agent Bridge under local DEV only (`sandbox: true` iff development).
   * owner session → ownerId; Bearer `abr_` → bridgeSecret.
   */
  async dispatchAgentBridge(request) {
    const store = this.agentBridgeStore;
    if (!store) return void 0;
    const appId = this.appId;
    const response = await handleAgentBridgeLocalRequest(request, {
      store,
      appId,
      sandbox: this.env.ARMADILLO_DEV_MODE === "1",
      resolveOwnerId: (req) => resolveOwnerIdFromSqliteSession(req, appId, (tokenHash, nowIso) => {
        const row = this.database.native.prepare(
          `SELECT user_id FROM ${internalTables.sessions}
            WHERE app_id = ? AND token_hash = ? AND expires_at > ?
            LIMIT 1`
        ).get(appId, tokenHash, nowIso);
        return row?.user_id;
      })
    });
    if (response && response.status === 404) {
      try {
        const pathname = new URL(request.url).pathname;
        if (/^\/join\/[^/]+\/?$/.test(pathname)) return void 0;
      } catch {
      }
    }
    return response;
  }
  async ensureDevelopmentAdmin() {
    const admin = this.developmentAdmin;
    if (!admin) return;
    const bootstrap = () => this.database.native.prepare(
      `SELECT group_id, user_id FROM ${internalTables.bootstrap} WHERE app_id = ? LIMIT 1`
    ).get(this.appId);
    let bootstrapRow = bootstrap();
    if (!bootstrapRow) {
      const response = await fetch(`${this.origin}${HTTP_API_PREFIX}/admin/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-armadillo-app-id": this.appId,
          "x-armadillo-bootstrap-secret": this.env.ARMADILLO_BOOTSTRAP_SECRET ?? ""
        },
        body: JSON.stringify(admin)
      });
      if (response.status !== 201) {
        throw new Error(`Unable to create the local development administrator (${response.status}).`);
      }
      bootstrapRow = bootstrap();
    }
    if (!bootstrapRow) throw new Error("Local bootstrap completed without a superadmin record.");
    const group = this.database.native.prepare(
      `SELECT id, trusted FROM ${internalTables.groups} WHERE app_id = ? AND id = ? LIMIT 1`
    ).get(this.appId, bootstrapRow.group_id);
    if (!group || group.trusted !== 1) {
      throw new Error("The local bootstrap superadmin group is missing or is not trusted.");
    }
    const existing = this.database.native.prepare(
      `SELECT id, password_iterations FROM ${internalTables.users} WHERE app_id = ? AND email = ? LIMIT 1`
    ).get(this.appId, admin.email);
    if (existing && existing.id !== bootstrapRow.user_id) {
      throw new Error(`developmentAdmin.email is already owned by a different local user: ${admin.email}`);
    }
    const passwordIterations = existing?.password_iterations ?? 1e5;
    const passwordSalt = Buffer.from(randomBytes(18)).toString("base64url");
    const passwordHashValue = await passwordHash(admin.password, passwordSalt, passwordIterations);
    const userId = existing?.id ?? `user_${Buffer.from(randomBytes(18)).toString("base64url")}`;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    this.database.native.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.database.native.prepare(
          `UPDATE ${internalTables.users}
              SET name = ?, password_hash = ?, password_salt = ?, password_iterations = ?,
                  password_enabled = 1, updated_at = ?
            WHERE app_id = ? AND id = ?`
        ).run(admin.name ?? null, passwordHashValue, passwordSalt, passwordIterations, timestamp, this.appId, userId);
      } else {
        this.database.native.prepare(
          `INSERT INTO ${internalTables.users}
             (app_id, id, email, name, password_hash, password_salt, password_iterations,
              password_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(this.appId, userId, admin.email, admin.name ?? null, passwordHashValue, passwordSalt, passwordIterations, timestamp, timestamp);
      }
      this.database.native.prepare(
        `DELETE FROM ${internalTables.sessions} WHERE app_id = ? AND user_id = ?`
      ).run(this.appId, userId);
      this.database.native.prepare(
        `INSERT INTO ${internalTables.groupMembers}
           (app_id, group_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', ?, ?)
         ON CONFLICT (app_id, group_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at`
      ).run(this.appId, group.id, userId, timestamp, timestamp);
      this.database.native.exec("COMMIT");
    } catch (error) {
      this.database.native.exec("ROLLBACK");
      throw error;
    }
  }
  async listen() {
    if (this.server) throw new Error("The local server is already listening.");
    this.server = createServer((incoming, outgoing) => {
      void Promise.resolve().then(() => this.handle(requestFromNode(incoming))).catch(errorResponse).then((response) => sendResponse(response, outgoing)).catch((error) => {
        if (isClientDisconnect(error, outgoing)) return;
        console.error(error);
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
    });
    this.server.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = LOCAL_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = LOCAL_KEEPALIVE_TIMEOUT_MS;
    this.server.maxConnections = LOCAL_MAX_CONNECTIONS;
    await new Promise((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.hostname, () => resolvePromise());
    });
    const address = this.server.address();
    const displayHost = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address.includes(":") ? `[${address.address}]` : address.address;
    this.currentOrigin = `http://${displayHost}:${address.port}`;
    this.env.ARMADILLO_PUBLIC_URL = this.currentOrigin;
    try {
      await this.ensureDevelopmentAdmin();
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.maintenanceIntervalMs > 0) {
      this.maintenance = setInterval(() => {
        void runScheduledSweep(this.env, this.backend).catch((error) => console.error("Local maintenance failed", error));
      }, this.maintenanceIntervalMs);
      this.maintenance.unref();
    }
    return this;
  }
  async close() {
    if (this.maintenance) clearInterval(this.maintenance);
    const server = this.server;
    this.server = void 0;
    if (server) {
      await new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    }
    await this.database.close();
    this.currentOrigin = void 0;
  }
}
async function local(backend, options) {
  return new LocalArmadilloServer(backend, options).listen();
}
export {
  LocalArmadilloServer,
  local
};
