import { middlewareDatabase } from "./engine/middleware/database.js";
import { schema, table, validateSchemaData } from "./schema.js";
function composeMiddleware(middleware, terminal) {
  return async (context) => {
    let last = -1;
    const dispatch = async (index) => {
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
function duration(value) {
  if (typeof value === "number") return value;
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(value ?? "1m");
  if (!match) throw new TypeError("Rate-limit window must look like 500ms, 30s, 1m, or 1h.");
  const amount = Number(match[1]);
  const units = { ms: 1, s: 1e3, m: 6e4, h: 36e5 };
  return amount * units[match[2]];
}
async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function rateLimit(options) {
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
       RETURNING count, reset_at`
    ).bind(await hash(`${context.appId}
function
${key}`), resetAt, updatedAt).first();
    if (row && row.count > options.max) {
      const error = new Error("Function rate limit exceeded.");
      error.status = 429;
      error.code = "RATE_LIMITED";
      throw error;
    }
    await next();
  };
}
function auditLog(options = {}) {
  return async (context, next) => {
    const startedAt = Date.now();
    try {
      await next();
      context.log("function.completed", {
        durationMs: Date.now() - startedAt,
        ...options.includeInput ? { input: context.data } : {}
      });
    } catch (error) {
      context.log("function.failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}
function abortError(signal) {
  return signal.reason ?? new DOMException("Retry aborted.", "AbortError");
}
function sleep(ms, signal) {
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
async function retry(run, options = {}) {
  if (typeof run !== "function") throw new TypeError("retry() requires a function to run.");
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new TypeError("Retry attempts must be from 1 to 20.");
  }
  const initialDelayMs = options.initialDelayMs ?? 250;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1 || initialDelayMs > 864e5) {
    throw new TypeError("Retry delay must be from 1 to 86400000 milliseconds.");
  }
  const maxDelayMs = options.maxDelayMs ?? 1e4;
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < 1 || maxDelayMs > 864e5) {
    throw new TypeError("Retry max delay must be from 1 to 86400000 milliseconds.");
  }
  const backoff = options.backoff ?? "exponential";
  if (backoff !== "fixed" && backoff !== "exponential") {
    throw new TypeError('Retry backoff must be "fixed" or "exponential".');
  }
  if (options.retryIf !== void 0 && typeof options.retryIf !== "function") {
    throw new TypeError("Retry retryIf must be a function.");
  }
  const retryIf = options.retryIf ?? ((error) => {
    const status = error?.status;
    return typeof status !== "number" || status === 429 || status >= 500;
  });
  const jitter = options.jitter ?? true;
  if (options.signal?.aborted) throw abortError(options.signal);
  let failure;
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
function validateInput(validation) {
  const validate = typeof validation === "function" ? validation : (data) => {
    const definition = schema({ FunctionInput: table(validation) });
    validateSchemaData(definition, "FunctionInput", data, false);
  };
  return async (context, next) => {
    await validate(context.data);
    await next();
  };
}
export {
  auditLog,
  composeMiddleware,
  rateLimit,
  retry,
  validateInput
};
