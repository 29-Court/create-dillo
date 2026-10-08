import type { ArmadilloBackendDefinition, ArmadilloDatabase } from "../backend.js";
import { type ArmadilloResources } from "../engine/runtime.js";
import { LocalSqliteDatabase } from "./sqlite.js";
import { LocalFileStorage } from "./storage.js";
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
export type LocalRequestHandler = (request: Request, context: LocalRequestContext) => Response | undefined | Promise<Response | undefined>;
export interface LocalDevelopmentAdmin {
    email: string;
    name?: string;
    password: string;
}
/** A self-contained Node HTTP server with native SQLite and local file storage. */
export declare class LocalArmadilloServer {
    private readonly backend;
    readonly database: LocalSqliteDatabase;
    readonly files: LocalFileStorage;
    private readonly env;
    private readonly publicDirectory;
    private readonly hostname;
    private readonly port;
    private readonly maintenanceIntervalMs;
    private readonly appId;
    private readonly developmentAdmin;
    private readonly requestHandler;
    /** DEV-only in-memory Agent Bridge store; undefined outside development. */
    private readonly agentBridgeStore?;
    private server;
    private maintenance;
    private currentOrigin;
    constructor(backend: ArmadilloBackendDefinition, options: LocalArmadilloOptions);
    get resources(): ArmadilloResources;
    get origin(): string;
    private staticResponse;
    /**
     * Handle one request through the full local pipeline (static files,
     * request handler, engine) without listening on a socket. Tests and tools
     * can drive a server in-process by passing this as a fetch implementation.
     */
    handle(request: Request): Promise<Response>;
    /**
     * Mount Agent Bridge under local DEV only (`sandbox: true` iff development).
     * owner session → ownerId; Bearer `abr_` → bridgeSecret.
     */
    private dispatchAgentBridge;
    private ensureDevelopmentAdmin;
    listen(): Promise<this>;
    close(): Promise<void>;
}
export declare function local(backend: ArmadilloBackendDefinition, options: LocalArmadilloOptions): Promise<LocalArmadilloServer>;
