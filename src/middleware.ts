import type { ArmadilloFunctionContext, JsonValue } from "./backend.js";
import { middlewareDatabase } from "./engine/middleware/database.js";
import { schema, table, validateSchemaData, type FieldMap } from "./schema.js";

export type Middleware = (
  context: ArmadilloFunctionContext,
  next: () => Promise<void>,
) => Promise<void>;

export function composeMiddleware(
  middleware: readonly Middleware[],
  terminal: () => Promise<void>,
): (context: ArmadilloFunctionContext) => Promise<void> {
  return async (context) => {
    let last = -1;
    const dispatch = async (index: number): Promise<void> => {
      if (index <= last) throw new Error("Middleware called next() more than once.");
      last = index;
      const current = middleware[index];
      if (!current) {
        await terminal();
        return;
      }
      await current(context, () => dispatch(index + 1));
    };
    await dispatch(0);
  };
}

export interface RateLimitMiddlewareOptions {
  window?: string | number;
  max: number;
  key?(context: ArmadilloFunctionContext): string;
}

function duration(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(value ?? "1m");
  if (!match) throw new TypeError("Rate-limit window must look like 500ms, 30s, 1m, or 1h.");
  const amount = Number(match[1]);
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return amount * units[match[2] as keyof typeof units];
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Database-backed fixed-window limit shared by every runtime instance. */
export function rateLimit(options: RateLimitMiddlewareOptions): Middleware {
  if (!Number.isSafeInteger(options.max) || options.max < 1) throw new TypeError("Rate-limit max must be positive.");
  const windowMs = duration(options.window);
  return async (context, next) => {
    const timestamp = Date.now();
    const key = options.key?.(context) ?? `${context.functionName}:${context.principal.id}`;
    const updatedAt = new Date(timestamp).toISOString();
    const resetAt = new Date(timestamp + windowMs).toISOString();
    const row = await middlewareDatabase(context).prepare(
      `INSERT INTO _armadillo_rate_limits (key_hash, count, reset_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         count = CASE WHEN reset_at <= excluded.updated_at THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= excluded.updated_at THEN excluded.reset_at ELSE reset_at END,
         updated_at = excluded.updated_at
       RETURNING count, reset_at`,
    ).bind(await hash(`${context.appId}\nfunction\n${key}`), resetAt, updatedAt)
      .first<{ count: number; reset_at: string }>();
    if (row && row.count > options.max) {
      const error = new Error("Function rate limit exceeded.") as Error & { status?: number; code?: string };
      error.status = 429;
      error.code = "RATE_LIMITED";
      throw error;
    }
    await next();
  };
}

/** Diagnostic function logging only; this does not persist a durable audit ledger. */
export function auditLog(options: { includeInput?: boolean } = {}): Middleware {
  return async (context, next) => {
    const startedAt = Date.now();
    try {
      await next();
      context.log("function.completed", {
        durationMs: Date.now() - startedAt,
        ...(options.includeInput ? { input: context.data as JsonValue } : {}),
      });
    } catch (error) {
      context.log("function.failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

export interface RetryOptions {
  /** Total attempts including the first call. From 1 to 20. Defaults to 3. */
  attempts?: number;
  /** Delay before the second attempt. From 1 to 86400000 milliseconds. Defaults to 250. */
  initialDelayMs?: number;
  /** Delay growth between attempts. Defaults to "exponential". */
  backoff?: "fixed" | "exponential";
  /** Upper bound for any single delay. From 1 to 86400000 milliseconds. Defaults to 10000. */
  maxDelayMs?: number;
  /** Randomize each delay down to as little as zero, so concurrent callers do not retry in lockstep. Defaults to true. */
  jitter?: boolean;
  /**
   * Decide whether a failure deserves another attempt. The default retries
   * status-less failures, 429, and 5xx, and never retries other 4xx errors.
   * A throwing predicate aborts retries with that error.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /** Abort waiting between attempts. An aborted wait throws the abort reason. */
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Retry aborted.", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Retry aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Re-run a flaky operation with backoff. Intended for idempotent work such as
 * calling an external API from a function handler; never wrap a write that
 * may already have committed. The last failure propagates unwrapped when the
 * attempts run out.
 */
export async function retry<T>(
  run: (attempt: number) => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  if (typeof run !== "function") throw new TypeError("retry() requires a function to run.");
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new TypeError("Retry attempts must be from 1 to 20.");
  }
  const initialDelayMs = options.initialDelayMs ?? 250;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1 || initialDelayMs > 86_400_000) {
    throw new TypeError("Retry delay must be from 1 to 86400000 milliseconds.");
  }
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < 1 || maxDelayMs > 86_400_000) {
    throw new TypeError("Retry max delay must be from 1 to 86400000 milliseconds.");
  }
  const backoff = options.backoff ?? "exponential";
  if (backoff !== "fixed" && backoff !== "exponential") {
    throw new TypeError('Retry backoff must be "fixed" or "exponential".');
  }
  if (options.retryIf !== undefined && typeof options.retryIf !== "function") {
    throw new TypeError("Retry retryIf must be a function.");
  }
  const retryIf = options.retryIf ?? ((error: unknown) => {
    const status = (error as { status?: unknown })?.status;
    return typeof status !== "number" || status === 429 || status >= 500;
  });
  const jitter = options.jitter ?? true;
  if (options.signal?.aborted) throw abortError(options.signal);
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      failure = error;
      if (attempt >= attempts || !retryIf(error, attempt)) throw error;
      const grown = backoff === "exponential" ? initialDelayMs * 2 ** (attempt - 1) : initialDelayMs;
      const capped = Math.min(grown, maxDelayMs);
      await sleep(jitter ? Math.floor(Math.random() * (capped + 1)) : capped, options.signal);
    }
  }
  throw failure;
}

export function validateInput(fields: FieldMap): Middleware;
export function validateInput(
  validate: (data: Readonly<Record<string, JsonValue>>) => void | Promise<void>,
): Middleware;
export function validateInput(
  validation: FieldMap | ((data: Readonly<Record<string, JsonValue>>) => void | Promise<void>),
): Middleware {
  const validate = typeof validation === "function"
    ? validation
    : (data: Readonly<Record<string, JsonValue>>) => {
      const definition = schema({ FunctionInput: table(validation) });
      validateSchemaData(definition, "FunctionInput", data, false);
    };
  return async (context, next) => {
    await validate(context.data);
    await next();
  };
}
