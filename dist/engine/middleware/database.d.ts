import type { ArmadilloDatabase, ArmadilloFunctionContext } from "../../backend.js";
/** @internal */
export declare function setMiddlewareDatabase(context: ArmadilloFunctionContext, resolve: () => ArmadilloDatabase): void;
/**
 * The database for engine-owned middleware. Prefers the internal handle, and
 * falls back to the public `db` accessor so trusted functions still work.
 *
 * @internal
 */
export declare function middlewareDatabase(context: ArmadilloFunctionContext): ArmadilloDatabase;
