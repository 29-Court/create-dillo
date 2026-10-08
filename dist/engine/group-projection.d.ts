import type { SchemaDefinition } from "../schema.js";
import type { ArmadilloEnv } from "./environment.js";
/** @internal Clears the process cache so the next request reads the projection table. */
export declare function forgetGroupProjection(appId?: string): void;
/** Copy each JSON team pointer into group_id once per schema. */
export declare function ensureGroupProjection(env: ArmadilloEnv, appId: string, schema: SchemaDefinition | undefined): Promise<void>;
