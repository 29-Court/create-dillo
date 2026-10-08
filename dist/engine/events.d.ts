import type { RealtimeStub } from "./ports.js";
import { type InternalEventWithActorRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
import { type JsonValue } from "../backend.js";
export declare function eventJson(row: InternalEventWithActorRow): JsonObject;
export declare function realtimeStub(env: ArmadilloEnv, currentAppId: string): Promise<RealtimeStub | undefined>;
/** @internal Read the deferral list, following the scoped-environment prototype chain. */
export declare function pendingRealtimeFor(env: ArmadilloEnv): Array<{
    appId: string;
    event: JsonObject;
}> | undefined;
/** A function transaction flushes notifications only after its database commits. */
export declare function deferRealtime(env: ArmadilloEnv): {
    flush(): Promise<void>;
    discard(): void;
};
export declare function broadcastRealtime(env: ArmadilloEnv, currentAppId: string, event: JsonObject): Promise<void>;
export declare function emitTableMutation(env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition, collection: string, type: "created" | "updated" | "deleted", record: JsonObject, _actorId: string): Promise<void>;
export declare function emitEvent(env: ArmadilloEnv, currentAppId: string, actorId: string, groupId: string, type: string, data: Record<string, JsonValue>, options: ArmadilloBackendDefinition): Promise<void>;
export declare function eventsRoute(request: Request, env: ArmadilloEnv, currentAppId: string): Promise<Response>;
export declare function decodeRealtimeCredential(value: string): string | undefined;
export declare function normalizeRealtimeRequest(request: Request): Request;
export declare function realtimeConnectRoute(request: Request, env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition): Promise<Response>;
