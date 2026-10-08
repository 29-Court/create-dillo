import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { type ArmadilloBackendDefinition } from "../backend.js";
/**
 * SQL the Cloudflare recipe imports so a unique `users.extend` field is
 * enforced on D1. Local startup already creates the same index.
 * Empty when the schema has no unique profile field.
 */
export declare function cloudflareProfileIndexSql(backend: ArmadilloBackendDefinition): string;
/** Core migrations, caller files, then the profile-index file when one is needed. */
export declare function cloudflareD1ImportPaths(backend: ArmadilloBackendDefinition, extra?: readonly string[], appId?: string): string[];
/** Bundle the generated Worker locally, without provisioning infrastructure. */
export declare function buildCloudflareWorker(entrypoint?: string): string;
/**
 * The single deployment declaration most applications need. Dillo generates
 * the tiny Worker adapter, owns D1 migrations, and lets Alchemy own lifecycle.
 */
export interface CloudflareAppOptions {
    /** Stable application namespace. It also names the stack resources. */
    id: string;
    /** The authoritative application and extension declarations. */
    backend: ArmadilloBackendDefinition;
    /** Only needed when two independently deployed apps share an `id`. */
    name?: string;
    /** Optional static assets served by the Worker. */
    assets?: string | {
        directory: string;
        /**
         * Mount the asset directory below a path such as `/ui` without moving the
         * files on disk. The directory's `index.html` is then available at that
         * path according to `htmlHandling`.
         */
        base?: string;
        htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
        notFoundHandling?: "none" | "404-page" | "single-page-application";
        runWorkerFirst?: boolean | string[];
    };
    /**
     * Application migrations appended after Dillo's immutable core schema.
     * Use this for app-owned indexes or tables, never to copy Dillo internals.
     */
    migrationFiles?: readonly string[];
    /**
     * Replace Dillo's generated Worker entrypoint when an app needs a small
     * route shell around the backend (for example, a public website plus `/api`).
     */
    entrypoint?: string;
    /** Public signup is deliberately opt-in. */
    signup?: "open" | "closed";
    /** Group created for the first bootstrap owner. */
    adminGroup?: string;
    /**
     * Bind the host secret `ARMADILLO_ADMIN_KEY`. Trusted groups can be created
     * only with that key. Supply the value in the deploy environment. Application
     * secrets cannot use this name.
     */
    adminKey?: boolean;
    /** Optional sign-in email branding. Credentials remain normal server secrets. */
    mail?: {
        from: string | Config.Config<string>;
        brand?: string;
        accentColor?: string;
        /** Credentials are read from the matching environment secrets at deploy. */
        provider?: "resend" | "cloudflare" | {
            webhook: string;
            token?: Config.Config<unknown>;
        };
    };
    /** Defaults to `*`; narrow this for browser clients on another origin. */
    corsOrigin?: string;
    /** Normal Alchemy Worker bindings for application-specific infrastructure. */
    bindings?: Cloudflare.WorkerBindings;
    /** Normal Alchemy Worker settings, excluding Dillo-owned wiring. */
    worker?: Omit<Cloudflare.WorkerProps, "main" | "bundle" | "assets" | "env" | "crons">;
}
/**
 * Host secret names for closed signup and trusted-group administration.
 * Does not read secret values. Alchemy loads each name from the deploy environment.
 */
export declare function cloudflareAuthoritySecrets(options?: {
    signup?: "open" | "closed";
    adminKey?: boolean;
}): string[];
export declare function app(options: CloudflareAppOptions): Effect.Effect<Alchemy.CompiledStack<{
    url: Alchemy.Output<string | undefined, never>;
    stage: string;
    appId: string;
    database: Alchemy.Output<string, never>;
    bucket: Alchemy.Output<string, never> | undefined;
}, any>, Config.ConfigError, never>;
/** Pure declaration validation; does not provision resources or read secret values. */
export declare function validateCloudflareBackend(backend: ArmadilloBackendDefinition, bindings?: Record<string, unknown>): void;
