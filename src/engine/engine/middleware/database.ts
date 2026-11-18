import type { ArmadilloDatabase, ArmadilloFunctionContext } from "../../backend.js";

/**
 * Internal handles to the invocation database, keyed by context object.
 *
 * `context.db` is deliberately gated behind `authority: "trusted"` because it is
 * raw SQL on a caller's behalf. Armadillo's own middleware faces a different
 * authority question: it is engine code that already shipped with the runtime,
 * not user handler code reaching for a back door. The built-in `rateLimit`
 * needs one small shared table, and it cannot reach through `trusted` (which
 * belongs to the handler) without making every rate-limited function trusted.
 *
 * These maps are how the engine hands that narrow capability to engine
 * middleware only. They used to be non-enumerable symbol properties planted on
 * the context, which stopped `for...in`, `Object.keys`, spread, and
 * `JSON.stringify` — but not `Object.getOwnPropertySymbols`. A handler could
 * walk the context's own symbols, find the raw database accessor, and skip the
 * `authority: "trusted"` gate entirely. A WeakMap has no reachable keys from the
 * value side, so there is nothing left to enumerate.
 */
const middlewareDatabases = new WeakMap<object, () => ArmadilloDatabase>();

/** @internal */
export function setMiddlewareDatabase(
  context: ArmadilloFunctionContext,
  resolve: () => ArmadilloDatabase,
): void {
  middlewareDatabases.set(context, resolve);
}

/**
 * The database for engine-owned middleware. Prefers the internal handle, and
 * falls back to the public `db` accessor so trusted functions still work.
 *
 * @internal
 */
export function middlewareDatabase(context: ArmadilloFunctionContext): ArmadilloDatabase {
  const internal = middlewareDatabases.get(context);
  if (internal) return internal();
  return (context as { db: ArmadilloDatabase }).db;
}