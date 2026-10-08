import { HTTP_API_PREFIX } from "../versions.js";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import type { ArmadilloBackendDefinition, ArmadilloDatabase } from "../backend.js";
import { createRuntimeEnvironment, type ArmadilloResources } from "../engine/runtime.js";
import { handleRequest } from "../engine/engine.js";
import { passwordHash } from "../engine/helpers/crypto.js";
import { runScheduledSweep } from "../engine/maintenance.js";
import type { EngineEnvironment } from "../engine/environment.js";
import { LocalSqliteDatabase } from "./sqlite.js";
import { LocalFileStorage } from "./storage.js";
import { isReservedFrameworkPath } from "../ui.js";
import {
  createLocalAgentBridgeStore,
  handleAgentBridgeLocalRequest,
  resolveOwnerIdFromSqliteSession,
  MemoryAgentBridgeStore,
} from "../agent-bridge/index.js";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function extension(pathname: string): string {
  const index = pathname.lastIndexOf(".");
  return index < 0 ? "" : pathname.slice(index).toLowerCase();
}

function requestFromNode(request: IncomingMessage): Request {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value) headers.append(name, value);
  }
  // Only the HTTP adapter knows the peer; callers cannot choose their own
  // authentication rate-limit bucket by forging proxy headers.
  headers.set("cf-connecting-ip", request.socket.remoteAddress ?? "unknown");
  headers.delete("x-forwarded-for");
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${headers.get("host") ?? "localhost"}`);
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(request) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  output.statusMessage = response.statusText;
  response.headers.forEach((value, name) => output.setHeader(name, value));
  if (!response.body) {
    output.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    output,
  );
}

function errorResponse(error: unknown): Response {
  console.error(error);
  return Response.json({ error: "INTERNAL_ERROR", message: "The local server could not handle the request." }, {
    status: 500,
  });
}

function isClientDisconnect(error: unknown, output: ServerResponse): boolean {
  if (output.destroyed || output.closed) return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ECONNRESET"
    || error.code === "EPIPE"
    || error.code === "ERR_STREAM_PREMATURE_CLOSE";
}

export interface LocalArmadilloOptions {
  appId: string;
  /** Local development is always distinct from an Alchemy deployment stage. */
  stage?: string;
  databasePath: string;
  filesDirectory: string;
  publicDirectory?: string;
  hostname?: string;
  port?: number;
  signupMode?: "open" | "closed";
  bootstrapSecret?: string;
  adminKey?: string;
  superadminGroup?: string;
  corsOrigin?: string;
  /**
   * Serve more than one tenant namespace selected by the `x-armadillo-app-id`
   * header. Off by default: the header is caller-controlled, and an anonymous
   * client that can pick the namespace also picks which rate-limit bucket its
   * brute force is charged to.
   */
  allowClientAppId?: boolean;
  /**
   * Read the client IP from a forwarded header for rate limiting. Only set this
   * when a proxy in front of the server rewrites that header, otherwise a
   * caller can mint a fresh rate-limit bucket per request.
   */
  trustForwardedIp?: boolean;
  development?: boolean;
  /** A loopback-only administrator reconciled on each local development startup. */
  developmentAdmin?: LocalDevelopmentAdmin;
  maintenanceIntervalMs?: number;
  allowUnsafeSchemaChanges?: boolean;
  maxJsonBytes?: number;
  maxFileBytes?: number;
  /** Immutable application migrations shared with the deployed database. */
  migrationFiles?: readonly string[];
  /** Application-specific runtime values, such as locally supplied secrets. */
  bindings?: Readonly<Record<string, unknown>>;
  /** Optional route shell for public application endpoints outside Armadillo's API. */
  requestHandler?: LocalRequestHandler;
}

export interface LocalRequestContext {
  database: ArmadilloDatabase;
  files: LocalFileStorage;
  bindings: Readonly<Record<string, unknown>>;
}

export type LocalRequestHandler = (
  request: Request,
  context: LocalRequestContext,
) => Response | undefined | Promise<Response | undefined>;

export interface LocalDevelopmentAdmin {
  email: string;
  name?: string;
  password: string;
}

interface DevelopmentAdminRow {
  id: string;
  password_iterations: number;
}

interface BootstrapRow {
  group_id: string;
  user_id: string;
}

interface TrustedGroupRow {
  id: string;
  trusted: number;
}

const internalTables = {
  bootstrap: "_armadillo_bootstrap",
  groupMembers: "_armadillo_group_members",
  groups: "_armadillo_groups",
  sessions: "_armadillo_sessions",
  users: "_armadillo_users",
} as const;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

/**
 * Local HTTP server limits.
 *
 * These are deliberately generous relative to a development workload and tight
 * relative to a slow-loris: a request has to arrive within `requestTimeout` and a
 * connection has to be released within `keepAliveTimeout`, so an idle or
 * trickling client cannot accumulate unbounded in-flight work.
 */
const LOCAL_REQUEST_TIMEOUT_MS = 120_000;
const LOCAL_HEADERS_TIMEOUT_MS = 30_000;
const LOCAL_KEEPALIVE_TIMEOUT_MS = 10_000;
const LOCAL_MAX_CONNECTIONS = 256;

function validateDevelopmentAdmin(admin: LocalDevelopmentAdmin): void {
  if (!admin.email.includes("@") || admin.email.length > 320) {
    throw new Error("developmentAdmin.email must be a valid email address.");
  }
  if (admin.password.length < 10 || admin.password.length > 1_024) {
    throw new Error("developmentAdmin.password must be between 10 and 1024 characters.");
  }
  if (admin.name !== undefined && admin.name.length > 160) {
    throw new Error("developmentAdmin.name must be at most 160 characters.");
  }
}

/** A self-contained Node HTTP server with native SQLite and local file storage. */
export class LocalArmadilloServer {
  readonly database: LocalSqliteDatabase;
  readonly files: LocalFileStorage;
  private readonly env: EngineEnvironment;
  private readonly publicDirectory: string | undefined;
  private readonly hostname: string;
  private readonly port: number;
  private readonly maintenanceIntervalMs: number;
  private readonly appId: string;
  private readonly developmentAdmin: LocalDevelopmentAdmin | undefined;
  private readonly requestHandler: LocalRequestHandler | undefined;
  /** DEV-only in-memory Agent Bridge store; undefined outside development. */
  private readonly agentBridgeStore?: MemoryAgentBridgeStore;
  private server: Server | undefined;
  private maintenance: NodeJS.Timeout | undefined;
  private currentOrigin: string | undefined;

  constructor(
    private readonly backend: ArmadilloBackendDefinition,
    options: LocalArmadilloOptions,
  ) {
    this.appId = options.appId;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.port = options.port ?? 8787;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 15 * 60 * 1_000;
    if (options.developmentAdmin) {
      if (!options.development || process.env.NODE_ENV === "production" || !isLoopbackHost(this.hostname)) {
        throw new Error("developmentAdmin requires a loopback server running in development mode.");
      }
      validateDevelopmentAdmin(options.developmentAdmin);
      this.developmentAdmin = options.developmentAdmin;
    }
    this.publicDirectory = options.publicDirectory ? resolve(options.publicDirectory) : undefined;
    this.requestHandler = options.requestHandler;
    // Enrollment surfaces only under local DEV, on loopback only. This used to be
    // gated on `options.development` alone, which meant
    // `new LocalArmadilloServer(backend, { development: true, hostname: "0.0.0.0" })`
    // published `/join/:token`, the enrollment, intent, and inbox routes on every
    // interface — with sandbox mode echoing the plaintext claim token and no rate
    // limiter, because the bridge is dispatched before the engine.
    if (options.development) {
      if (process.env.NODE_ENV === "production" || !isLoopbackHost(this.hostname)) {
        throw new Error("development mode requires a loopback server running outside production.");
      }
      this.agentBridgeStore = createLocalAgentBridgeStore();
    }
    this.database = new LocalSqliteDatabase(options.databasePath, {
      appId: options.appId,
      ...(backend.schema ? { schema: backend.schema } : {}),
      ...(options.migrationFiles ? { migrationFiles: options.migrationFiles } : {}),
      ...(options.allowUnsafeSchemaChanges === undefined
        ? {}
        : { allowUnsafeSchemaChanges: options.allowUnsafeSchemaChanges }),
    });
    this.files = new LocalFileStorage(options.filesDirectory);
    const { ARMADILLO_REALTIME, ARMADILLO_FILE_URLS, ...bindings } = options.bindings ?? {};
    try {
      this.env = createRuntimeEnvironment({
        appId: options.appId,
        backend,
        database: this.database,
        storage: this.files,
        ...(ARMADILLO_REALTIME ? { realtime: ARMADILLO_REALTIME as NonNullable<EngineEnvironment["ARMADILLO_REALTIME"]> } : {}),
        ...(ARMADILLO_FILE_URLS ? { fileUrls: ARMADILLO_FILE_URLS as NonNullable<EngineEnvironment["ARMADILLO_FILE_URLS"]> } : {}),
        stage: options.stage ?? "local",
        signup: options.signupMode ?? "closed",
        corsOrigin: options.corsOrigin ?? "*",
        bindings: Object.fromEntries(Object.entries({
          ARMADILLO_BOOTSTRAP_SECRET: options.bootstrapSecret,
          ARMADILLO_ADMIN_KEY: options.adminKey,
          ARMADILLO_SUPERADMIN_GROUP: options.superadminGroup,
          ARMADILLO_ALLOW_CLIENT_APP_ID: options.allowClientAppId ? "1" : undefined,
          ARMADILLO_TRUST_FORWARDED_IP: options.trustForwardedIp ? "1" : undefined,
          ARMADILLO_DEV_MODE: options.development ? "1" : undefined,
          // `development` is already refused unless the host is loopback and
          // NODE_ENV is not production (see the constructor), which is the
          // precondition for handing out a live sign-in token in a response.
          ARMADILLO_EXPOSE_DEBUG_TOKENS: options.development ? "1" : undefined,
          ARMADILLO_SQL_DIALECT: "sqlite",
          ARMADILLO_STORAGE_LABELS: ["SQLite", ...(backend.files !== false ? ["local filesystem"] : [])],
          ARMADILLO_PURPOSE: "Self-hosted Armadillo on Node.js, SQLite, and local file storage.",
          ARMADILLO_MAX_JSON_BYTES: options.maxJsonBytes === undefined ? undefined : String(options.maxJsonBytes),
          ARMADILLO_MAX_FILE_BYTES: options.maxFileBytes === undefined ? undefined : String(options.maxFileBytes),
          ...bindings,
        }).filter(([, value]) => value !== undefined)),
      });
    } catch (error) {
      void this.database.close();
      throw error;
    }
  }

  get resources(): ArmadilloResources {
    return this.env.resources!;
  }

  get origin(): string {
    if (!this.currentOrigin) throw new Error("The local server is not listening yet.");
    return this.currentOrigin;
  }

  private async staticResponse(request: Request): Promise<Response | undefined> {
    if (!this.publicDirectory || (request.method !== "GET" && request.method !== "HEAD")) return undefined;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Malformed path", { status: 400 });
    }
    if (pathname.includes("\0")) return new Response("Malformed path", { status: 400 });
    if (isReservedFrameworkPath(pathname)) return undefined;
    if (Object.values(this.backend.ui?.apps ?? {}).some(app => app.path === pathname)) return undefined;
    let relative = pathname.replace(/^\/+/, "");
    if (!relative || relative.endsWith("/")) relative += "index.html";
    if (relative.split("/").includes("..")) return new Response("Forbidden", { status: 403 });
    const candidate = resolve(this.publicDirectory, relative);
    if (candidate !== this.publicDirectory && !candidate.startsWith(`${this.publicDirectory}${sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const info = await stat(candidate);
      if (!info.isFile()) return undefined;
      const etag = `W/"${createHash("sha256").update(`${info.size}:${info.mtimeMs}`).digest("base64url")}"`;
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      const headers = new Headers({
        "cache-control": extension(candidate) === ".html" ? "no-cache" : "public, max-age=3600",
        "content-length": String(info.size),
        "content-type": contentTypes[extension(candidate)] ?? "application/octet-stream",
        etag,
        "x-content-type-options": "nosniff",
      });
      const body = request.method === "HEAD"
        ? null
        : Readable.toWeb(createReadStream(candidate)) as ReadableStream;
      return new Response(body, { headers });
    } catch (error) {
      // ENAMETOOLONG joins ENOENT: an absurdly long path is not a file we can
      // serve, and must not become an unauthenticated 500 with an fs stack.
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENAMETOOLONG")) return undefined;
      throw error;
    }
  }

  /**
   * Handle one request through the full local pipeline (static files,
   * request handler, engine) without listening on a socket. Tests and tools
   * can drive a server in-process by passing this as a fetch implementation.
   */
  async handle(request: Request): Promise<Response> {
    const staticResponse = await this.staticResponse(request);
    if (staticResponse) return staticResponse;
    // Agent Bridge enrollment (DEV sandbox only). Leaves /v1/tickets alone.
    const bridgeResponse = await this.dispatchAgentBridge(request);
    if (bridgeResponse) return bridgeResponse;
    const applicationResponse = await this.requestHandler?.(request, {
      database: this.database,
      files: this.files,
      bindings: this.env as unknown as Record<string, unknown>,
    });
    return applicationResponse ?? handleRequest(request, this.env, this.backend);
  }

  /**
   * Mount Agent Bridge under local DEV only (`sandbox: true` iff development).
   * owner session → ownerId; Bearer `abr_` → bridgeSecret.
   */
  private async dispatchAgentBridge(request: Request): Promise<Response | undefined> {
    const store = this.agentBridgeStore;
    if (!store) return undefined;
    const appId = this.appId;
    const response = await handleAgentBridgeLocalRequest(request, {
      store,
      appId,
      sandbox: this.env.ARMADILLO_DEV_MODE === "1",
      resolveOwnerId: (req) => resolveOwnerIdFromSqliteSession(req, appId, (tokenHash, nowIso) => {
        const row = this.database.native.prepare(
          `SELECT user_id FROM ${internalTables.sessions}
            WHERE app_id = ? AND token_hash = ? AND expires_at > ?
            LIMIT 1`,
        ).get(appId, tokenHash, nowIso) as { user_id: string } | undefined;
        return row?.user_id;
      }),
    });
    // Fall through unknown /join tickets to the engine bridge (Mac SQLite invites).
    // Origin's in-memory store only owns tickets it minted via /v1/enroll/tickets.
    if (response && response.status === 404) {
      try {
        const pathname = new URL(request.url).pathname;
        if (/^\/join\/[^/]+\/?$/.test(pathname)) return undefined;
      } catch {
        // Malformed URL — keep the bridge response.
      }
    }
    return response;
  }

  private async ensureDevelopmentAdmin(): Promise<void> {
    const admin = this.developmentAdmin;
    if (!admin) return;

    const bootstrap = () => this.database.native.prepare(
      `SELECT group_id, user_id FROM ${internalTables.bootstrap} WHERE app_id = ? LIMIT 1`,
    ).get(this.appId) as BootstrapRow | undefined;
    let bootstrapRow = bootstrap();
    if (!bootstrapRow) {
      const response = await fetch(`${this.origin}${HTTP_API_PREFIX}/admin/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-armadillo-app-id": this.appId,
          "x-armadillo-bootstrap-secret": this.env.ARMADILLO_BOOTSTRAP_SECRET ?? "",
        },
        body: JSON.stringify(admin),
      });
      if (response.status !== 201) {
        throw new Error(`Unable to create the local development administrator (${response.status}).`);
      }
      bootstrapRow = bootstrap();
    }
    if (!bootstrapRow) throw new Error("Local bootstrap completed without a superadmin record.");

    const group = this.database.native.prepare(
      `SELECT id, trusted FROM ${internalTables.groups} WHERE app_id = ? AND id = ? LIMIT 1`,
    ).get(this.appId, bootstrapRow.group_id) as TrustedGroupRow | undefined;
    if (!group || group.trusted !== 1) {
      throw new Error("The local bootstrap superadmin group is missing or is not trusted.");
    }

    const existing = this.database.native.prepare(
      `SELECT id, password_iterations FROM ${internalTables.users} WHERE app_id = ? AND email = ? LIMIT 1`,
    ).get(this.appId, admin.email) as DevelopmentAdminRow | undefined;
    if (existing && existing.id !== bootstrapRow.user_id) {
      throw new Error(`developmentAdmin.email is already owned by a different local user: ${admin.email}`);
    }

    const passwordIterations = existing?.password_iterations ?? 100_000;
    const passwordSalt = Buffer.from(randomBytes(18)).toString("base64url");
    const passwordHashValue = await passwordHash(admin.password, passwordSalt, passwordIterations);
    const userId = existing?.id ?? `user_${Buffer.from(randomBytes(18)).toString("base64url")}`;
    const timestamp = new Date().toISOString();

    this.database.native.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.database.native.prepare(
          `UPDATE ${internalTables.users}
              SET name = ?, password_hash = ?, password_salt = ?, password_iterations = ?,
                  password_enabled = 1, updated_at = ?
            WHERE app_id = ? AND id = ?`,
        ).run(admin.name ?? null, passwordHashValue, passwordSalt, passwordIterations, timestamp, this.appId, userId);
      } else {
        this.database.native.prepare(
          `INSERT INTO ${internalTables.users}
             (app_id, id, email, name, password_hash, password_salt, password_iterations,
              password_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(this.appId, userId, admin.email, admin.name ?? null, passwordHashValue, passwordSalt, passwordIterations, timestamp, timestamp);
      }
      this.database.native.prepare(
        `DELETE FROM ${internalTables.sessions} WHERE app_id = ? AND user_id = ?`,
      ).run(this.appId, userId);
      this.database.native.prepare(
        `INSERT INTO ${internalTables.groupMembers}
           (app_id, group_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', ?, ?)
         ON CONFLICT (app_id, group_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at`,
      ).run(this.appId, group.id, userId, timestamp, timestamp);
      this.database.native.exec("COMMIT");
    } catch (error) {
      this.database.native.exec("ROLLBACK");
      throw error;
    }
  }

  async listen(): Promise<this> {
    if (this.server) throw new Error("The local server is already listening.");
    this.server = createServer((incoming, outgoing) => {
      void Promise.resolve()
        .then(() => this.handle(requestFromNode(incoming)))
        .catch(errorResponse)
        .then((response) => sendResponse(response, outgoing))
        .catch((error: unknown) => {
          if (isClientDisconnect(error, outgoing)) return;
          console.error(error);
          if (!outgoing.headersSent) outgoing.writeHead(500);
          outgoing.end();
        });
    });
    // Node's defaults leave a 300 s request timeout and no ceiling on concurrent
    // connections, so a handful of clients opening a socket and never finishing a
    // body could hold unbounded in-flight requests, each retaining a body stream
    // and a slot on the serialized SQLite write queue.
    this.server.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = LOCAL_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = LOCAL_KEEPALIVE_TIMEOUT_MS;
    this.server.maxConnections = LOCAL_MAX_CONNECTIONS;
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.hostname, () => resolvePromise());
    });
    const address = this.server.address() as AddressInfo;
    const displayHost = address.address === "::" || address.address === "0.0.0.0"
      ? "127.0.0.1"
      : address.address.includes(":") ? `[${address.address}]` : address.address;
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
        void runScheduledSweep(this.env, this.backend).catch((error: unknown) => console.error("Local maintenance failed", error));
      }, this.maintenanceIntervalMs);
      this.maintenance.unref();
    }
    return this;
  }

  async close(): Promise<void> {
    if (this.maintenance) clearInterval(this.maintenance);
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    }
    await this.database.close();
    this.currentOrigin = undefined;
  }
}

export async function local(
  backend: ArmadilloBackendDefinition,
  options: LocalArmadilloOptions,
): Promise<LocalArmadilloServer> {
  return new LocalArmadilloServer(backend, options).listen();
}
