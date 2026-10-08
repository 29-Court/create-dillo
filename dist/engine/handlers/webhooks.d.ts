import type { ArmadilloStatement } from "../../backend.js";
import type { EngineDatabase } from "../ports.js";
import { type ArmadilloBackendDefinition } from "../../backend.js";
interface WebhookDatabaseEnvironment {
    DB: EngineDatabase;
}
export declare function prepareWebhookEvent(env: WebhookDatabaseEnvironment, currentAppId: string, options: ArmadilloBackendDefinition, name: string, data: Record<string, unknown>, actorId?: string): Promise<ArmadilloStatement[]>;
export declare function enqueueWebhookEvent(...args: Parameters<typeof prepareWebhookEvent>): Promise<void>;
export declare function deliverWebhookJobs(env: WebhookDatabaseEnvironment, timestamp: string, version: string, fetcher?: typeof fetch): Promise<void>;
export {};
