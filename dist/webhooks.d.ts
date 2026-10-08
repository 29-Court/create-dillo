export interface WebhookEvent<TData = Record<string, unknown>> {
    id: string;
    name: string;
    appId: string;
    data: TData;
    actorId?: string;
    timestamp: string;
}
export interface WebhookRetryOptions {
    attempts?: number;
    backoff?: "fixed" | "exponential";
    initialDelayMs?: number;
}
export interface WebhookDefinition {
    url: string;
    /** Prefer secret('WEBHOOK_SIGNING_KEY') to keep values out of source code. */
    secret: string | ArmadilloSecret<string, true>;
    events: readonly string[];
    retry?: WebhookRetryOptions;
    transform?(event: WebhookEvent): unknown | Promise<unknown>;
}
export interface WebhookJob {
    webhookName: string;
    url: string;
    payload: string;
    signature: string;
    maxAttempts: number;
    initialDelayMs: number;
    backoff: "fixed" | "exponential";
}
export declare function hmacSha256Hex(secret: string, message: string): Promise<string>;
/**
 * The signed material for a delivery: the timestamp, then the body.
 *
 * Signing the timestamp is what makes a captured request unusable later. The
 * signature previously covered only `payload`, so anyone who observed one
 * delivery could replay that exact pair indefinitely — and with up to 20
 * attempts per job, a validly signed body could legitimately arrive 20 times.
 */
export declare function signatureInput(timestamp: string, payload: string): string;
export declare function signPayload(payload: string, secret: string): Promise<string>;
/**
 * Sign a delivery so a receiver can both authenticate it and bound its age.
 *
 * Receivers should reject anything outside their own skew window; this helper
 * only produces the value they compare.
 */
export declare function signDelivery(payload: string, secret: string, timestamp?: string): Promise<string>;
export declare function constantTimeEqual(left: string, right: string): boolean;
/** Constant-time comparison for secrets whose length is itself sensitive. */
export declare function constantTimeEqualSecret(left: string, right: string): Promise<boolean>;
export declare function verifySignature(payload: string, signature: string, secret: string, timestamp?: string): Promise<boolean>;
/** Seconds a receiver should tolerate between `X-Armadillo-Timestamp` and now. */
export declare const WEBHOOK_TIMESTAMP_SKEW_SECONDS = 300;
export declare function isPrivateWebhookDestination(hostname: string): boolean;
export declare function validateWebhookDefinitions(definitions: Record<string, WebhookDefinition> | undefined): void;
export declare function buildWebhookJobs(definitions: Record<string, WebhookDefinition> | undefined, event: WebhookEvent, secrets?: Readonly<Record<string, unknown>>): Promise<WebhookJob[]>;
export declare function webhookRetryDelay(job: Pick<WebhookJob, "initialDelayMs" | "backoff">, attempts: number): number;
import type { ArmadilloSecret } from "./backend.js";
