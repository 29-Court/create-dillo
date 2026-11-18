import type {
  ArmadilloCollectorDefinition,
  ArmadilloFunctionDefinition,
  ArmadilloRegisteredApp,
  ArmadilloRequestListener,
} from "./backend.js";
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

/** Runtime keys an extension may never see, whatever it declares. */
const NEVER_EXPOSED_TO_EXTENSIONS = new Set([
  "DB", "FILES", "ARMADILLO_ADMIN_KEY", "ARMADILLO_BOOTSTRAP_SECRET",
  "ARMADILLO_SECRET_VAULT", "MAIL_QUEUE", "ARMADILLO_REALTIME",
  "RESEND_API_KEY", "CF_EMAIL_API_TOKEN", "CF_ACCOUNT_ID", "R2_SECRET_ACCESS_KEY",
]);

/** Values a secret-shaped key may still hide behind. */
const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|_KEY$|^KEY$|CREDENTIAL)/i;

/**
 * Build the view of the runtime an extension is allowed to see.
 *
 * Only declared secret names are passed through, as their configured values,
 * because that is the one capability an extension legitimately needs. Everything
 * else structural — the database, object storage, and any key that looks like a
 * credential — is dropped whether or not it was declared.
 */
export function extensionRuntimeView(
  env: Record<string, unknown>,
  declaredSecrets: readonly string[],
): Readonly<Record<string, unknown>> {
  const allowed = new Set(
    declaredSecrets.filter((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && !NEVER_EXPOSED_TO_EXTENSIONS.has(name)),
  );
  const view: Record<string, unknown> = Object.create(null);
  // `for...in`, not `Object.entries`: a function invocation runs inside
  // `operation()`, which scopes the environment with `Object.create(env)`. Every
  // binding therefore sits on the prototype chain, and an own-keys walk would
  // hand the extension an empty view — the safe-looking failure that silently
  // starves legitimate capabilities.
  const deny = new Set<string>();
  for (const key in env) {
    if (deny.has(key)) continue;
    deny.add(key);
    if (NEVER_EXPOSED_TO_EXTENSIONS.has(key)) continue;
    if (allowed.has(key)) { view[key] = env[key]; continue; }
    if (SECRET_NAME.test(key) || key.startsWith("ARMADILLO_")) continue;
    view[key] = env[key];
  }
  return Object.freeze(view);
}

/**
 * Strip the caller's credentials before a request crosses into extension code.
 *
 * Deliberately metadata-only: the body is already being consumed by the engine
 * and re-wrapping it would disturb the live stream, and an extension has no
 * business reading a caller's payload or bearer credential.
 */
export function extensionRequestView(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-armadillo-admin-key");
  headers.delete("x-armadillo-bootstrap-secret");
  headers.delete("x-armadillo-client-key");
  return new Request(request.url, { method: request.method, headers });
}

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

export type ExtensionEnvironmentOf<TExtension> =
  TExtension extends ArmadilloExtension<infer TEnvironment> ? TEnvironment : {};

/** Define and validate an extension without importing framework internals. */
export function defineExtension<
  const TEnvironment extends ArmadilloExtensionEnvironment,
  const TFunctions extends Record<string, ArmadilloFunctionDefinition<TEnvironment>> = {},
>(
  extension: Omit<ArmadilloExtension<TEnvironment>, "functions"> & {
    functions?: TFunctions & Record<string, ArmadilloFunctionDefinition<TEnvironment>>;
  },
): Omit<ArmadilloExtension<TEnvironment>, "functions"> & { functions: TFunctions } {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(extension.name)) {
    throw new TypeError("Extension names must use lowercase letters, numbers, and hyphens.");
  }
  for (const requirement of extension.requirements?.secrets ?? []) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(requirement.name)) {
      throw new TypeError(`Extension secret requirement \`${requirement.name}\` is invalid.`);
    }
  }
  for (const requirement of extension.requirements?.infrastructure ?? []) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(requirement.name)
      || !["queue", "storage", "webhook", "service"].includes(requirement.kind)) {
      throw new TypeError(`Extension infrastructure requirement \`${requirement.name}\` is invalid.`);
    }
  }
  return { ...extension, functions: extension.functions ?? {} } as Omit<ArmadilloExtension<TEnvironment>, "functions"> & { functions: TFunctions };
}

/** Resolve extension capabilities once for an incoming backend request. */
export async function resolveExtensionEnvironment(
  extensions: readonly ArmadilloExtension[] | undefined,
  context: ArmadilloExtensionRuntimeContext,
): Promise<Readonly<ArmadilloExtensionEnvironment>> {
  const environment: Record<string, unknown> = Object.create(null);
  for (const extension of extensions ?? []) {
    // Narrow `context` to this extension's declared surface before calling it, so
    // one extension cannot read another's declared secrets.
    const declared = (extension.requirements?.secrets ?? []).map((requirement) => requirement.name);
    const scoped: ArmadilloExtensionRuntimeContext = {
      appId: context.appId,
      request: extensionRequestView(context.request),
      runtime: extensionRuntimeView(context.runtime as Record<string, unknown>, declared),
    };
    const contribution = typeof extension.env === "function"
      ? await extension.env(scoped)
      : extension.env;
    if (!contribution) continue;
    if (typeof contribution !== "object" || Array.isArray(contribution)) {
      throw new TypeError(`Extension ${extension.name} must provide an environment object.`);
    }
    for (const [name, value] of Object.entries(contribution)) {
      if (Object.hasOwn(environment, name)) {
        throw new Error(`Extensions may not both provide env.${name}.`);
      }
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}
