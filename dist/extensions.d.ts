import type { ArmadilloCollectorDefinition, ArmadilloFunctionDefinition, ArmadilloRegisteredApp, ArmadilloRequestListener } from "./backend.js";
import type { Middleware } from "./middleware.js";
/** Values an extension makes available to backend functions as `context.env`. */
export type ArmadilloExtensionEnvironment = object;
/**
 * The provider-neutral information available while an extension creates its
 * runtime capability.
 *
 * The runtime is a **redacted** view, never the live environment. `runtime` used
 * to be the whole `ArmadilloEnv`, which handed every extension the raw database,
 * object storage, `ARMADILLO_ADMIN_KEY`, `ARMADILLO_BOOTSTRAP_SECRET`, and every
 * application secret on every function invocation — regardless of what the
 * extension declared. That turned one compromised transitive dependency into a
 * full application compromise that bypassed `authority: "trusted"` and every
 * record policy.
 *
 * `request` is likewise stripped of the caller's credentials. Extensions are
 * third-party code on a request path; they do not need the session bearer.
 */
export interface ArmadilloExtensionRuntimeContext {
    appId: string;
    request: Request;
    /** Non-secret configuration values only. Never `DB`, `FILES`, or a secret. */
    runtime: Readonly<Record<string, unknown>>;
}
/**
 * Build the view of the runtime an extension is allowed to see.
 *
 * Only declared secret names are passed through, as their configured values,
 * because that is the one capability an extension legitimately needs. Everything
 * else structural — the database, object storage, and any key that looks like a
 * credential — is dropped whether or not it was declared.
 */
export declare function extensionRuntimeView(env: Record<string, unknown>, declaredSecrets: readonly string[]): Readonly<Record<string, unknown>>;
/**
 * Strip the caller's credentials before a request crosses into extension code.
 *
 * Deliberately metadata-only: the body is already being consumed by the engine
 * and re-wrapping it would disturb the live stream, and an extension has no
 * business reading a caller's payload or bearer credential.
 */
export declare function extensionRequestView(request: Request): Request;
/** Declarative deployment inputs. Deployment integrations decide how to wire them. */
export interface ArmadilloExtensionRequirements {
    secrets?: readonly {
        name: string;
        description?: string;
        required?: boolean;
    }[];
    infrastructure?: readonly {
        kind: "queue" | "storage" | "webhook" | "service";
        name: string;
        description?: string;
    }[];
}
/**
 * The narrow, supported contract for an Armadillo extension. It deliberately
 * exposes application capabilities rather than mutable framework internals.
 */
export interface ArmadilloExtension<TEnvironment extends ArmadilloExtensionEnvironment = {}> {
    name: string;
    description?: string;
    functions?: Record<string, ArmadilloFunctionDefinition<TEnvironment>>;
    middleware?: readonly Middleware[];
    listener?: ArmadilloRequestListener;
    apps?: Record<string, ArmadilloRegisteredApp>;
    collectors?: Record<string, ArmadilloCollectorDefinition>;
    requirements?: ArmadilloExtensionRequirements;
    /**
     * Static capabilities or a per-request factory. This is how an extension
     * contributes a typed value such as `env.EMAIL` without global declarations.
     */
    env?: TEnvironment | ((context: ArmadilloExtensionRuntimeContext) => TEnvironment | Promise<TEnvironment>);
}
export type ExtensionEnvironmentOf<TExtension> = TExtension extends ArmadilloExtension<infer TEnvironment> ? TEnvironment : {};
/** Define and validate an extension without importing framework internals. */
export declare function defineExtension<const TEnvironment extends ArmadilloExtensionEnvironment, const TFunctions extends Record<string, ArmadilloFunctionDefinition<TEnvironment>> = {}>(extension: Omit<ArmadilloExtension<TEnvironment>, "functions"> & {
    functions?: TFunctions & Record<string, ArmadilloFunctionDefinition<TEnvironment>>;
}): Omit<ArmadilloExtension<TEnvironment>, "functions"> & {
    functions: TFunctions;
};
/** Resolve extension capabilities once for an incoming backend request. */
export declare function resolveExtensionEnvironment(extensions: readonly ArmadilloExtension[] | undefined, context: ArmadilloExtensionRuntimeContext): Promise<Readonly<ArmadilloExtensionEnvironment>>;
