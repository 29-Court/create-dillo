import { type InternalApiKeyRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type InternalApiKeyAuditRow } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
export declare function apiKeyJson(row: InternalApiKeyRow): JsonObject;
export declare function apiKeyAuditJson(row: InternalApiKeyAuditRow): JsonObject;
export declare function apiKeyDescription(value: unknown): string | null;
export declare function apiKeyScopes(value: unknown): string[];
export declare function recordApiKeyAudit(env: ArmadilloEnv, currentAppId: string, keyId: string, actorId: string, eventType: InternalApiKeyAuditRow["event_type"], details: JsonObject, timestamp?: string): Promise<void>;
export declare function issueApiKey(env: ArmadilloEnv, currentAppId: string, ownerId: string, input: {
    name: string;
    description: string | null;
    scopes: string[];
    expiresAt: string | null;
    rotatedFrom?: string;
}): Promise<{
    apiKey: InternalApiKeyRow;
    secret: string;
}>;
export declare function apiKeyForOwner(env: ArmadilloEnv, currentAppId: string, ownerId: string, id: string): Promise<InternalApiKeyRow>;
export declare function apiKeysRoute(request: Request, env: ArmadilloEnv, currentAppId: string, id?: string, action?: string): Promise<Response>;
