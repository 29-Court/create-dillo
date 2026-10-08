import type { MailBatch } from "./ports.js";
import { type ArmadilloEnv } from "./environment.js";
/**
 * Consumer-side attempt ceiling. Cloudflare Queues may also DLQ, but the DB
 * status must become terminal even when no queue DLQ is configured. Matches
 * the webhook outbox idea: bounded retries, then stop.
 */
export declare const MAIL_QUEUE_MAX_ATTEMPTS = 5;
export declare function consumeMailQueue(batch: MailBatch, env: ArmadilloEnv): Promise<void>;
