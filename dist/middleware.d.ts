import type { ArmadilloFunctionContext, JsonValue } from "./backend.js";
import { type FieldMap } from "./schema.js";
export type Middleware = (context: ArmadilloFunctionContext, next: () => Promise<void>) => Promise<void>;
export declare function composeMiddleware(middleware: readonly Middleware[], terminal: () => Promise<void>): (context: ArmadilloFunctionContext) => Promise<void>;
export interface RateLimitMiddlewareOptions {
    window?: string | number;
    max: number;
    key?(context: ArmadilloFunctionContext): string;
}
/** Database-backed fixed-window limit shared by every runtime instance. */
export declare function rateLimit(options: RateLimitMiddlewareOptions): Middleware;
/** Diagnostic function logging only; this does not persist a durable audit ledger. */
export declare function auditLog(options?: {
    includeInput?: boolean;
}): Middleware;
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
/**
 * Re-run a flaky operation with backoff. Intended for idempotent work such as
 * calling an external API from a function handler; never wrap a write that
 * may already have committed. The last failure propagates unwrapped when the
 * attempts run out.
 */
export declare function retry<T>(run: (attempt: number) => Promise<T> | T, options?: RetryOptions): Promise<T>;
export declare function validateInput(fields: FieldMap): Middleware;
export declare function validateInput(validate: (data: Readonly<Record<string, JsonValue>>) => void | Promise<void>): Middleware;
