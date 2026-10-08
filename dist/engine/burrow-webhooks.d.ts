import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
type JobStatus = "pending" | "delivered" | "quarantine";
interface WebhookJobRow {
    id: string;
    webhook_name: string;
    url: string;
    payload: string;
    signature: string;
    attempts: number;
    max_attempts: number;
    backoff: "fixed" | "exponential";
    initial_delay_ms: number;
    next_retry_at: string | null;
    last_status: number | null;
    last_response: string | null;
    created_at: string;
}
declare function jobSummary(row: WebhookJobRow, includePayload: boolean): {
    payload?: string;
    id: string;
    webhookName: string;
    urlHost: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    backoff: "fixed" | "exponential";
    initialDelayMs: number;
    nextRetryAt: string | null;
    lastStatus: number | null;
    lastError: string | null;
    createdAt: string;
};
/** Per-endpoint rollups a tired operator can scan. */
export declare function webhookEndpointRollups(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition): Promise<Array<{
    name: string;
    urlHost: string;
    delivered: number;
    failed: number;
    pending: number;
    quarantined: number;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
}>>;
export declare function webhookQuarantineWindow(env: ArmadilloEnv, appId: string): Promise<{
    jobs: ReturnType<typeof jobSummary>[];
    quarantineWindow: {
        returned: number;
        total: number;
        truncated: boolean;
    };
}>;
/** Operator webhook surface under /v1/burrow/webhooks[...]. */
export declare function burrowWebhooksRoute(request: Request, env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, segments: readonly string[]): Promise<Response>;
export {};
