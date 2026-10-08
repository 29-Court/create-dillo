import type { D1Database, R2Bucket, DurableObjectNamespace, Queue, ExportedHandler } from '@cloudflare/workers-types';
import type { ArmadilloBackendDefinition } from '../backend.js';
import type { EngineEnvironment } from '../engine/environment.js';
import type { SendMailJob } from '../engine/mail.js';
export * from '../internal-schema.js';
export { presignR2Url, type R2SigningCredentials } from './r2-presign.js';
export type { SendMailJob } from '../engine/mail.js';
export type { ArmadilloFileUrlAdapter } from '../engine/environment.js';
export { ARMADILLO_VERSION } from '../engine/environment.js';
export interface ArmadilloCloudflareBindings extends Omit<EngineEnvironment, 'DB' | 'FILES' | 'ARMADILLO_REALTIME' | 'MAIL_QUEUE' | 'resources'> {
    R2_ACCOUNT_ID?: string;
    R2_BUCKET_NAME?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    DB: D1Database;
    FILES?: R2Bucket;
    ARMADILLO_REALTIME?: DurableObjectNamespace;
    MAIL_QUEUE?: Queue<SendMailJob>;
}
export declare function handleCloudflareRequest(request: Request, env: ArmadilloCloudflareBindings, backend?: ArmadilloBackendDefinition): Promise<Response>;
export declare function runScheduledSweep(env: ArmadilloCloudflareBindings, backend?: ArmadilloBackendDefinition): Promise<void>;
export declare function cloudflare(backend?: ArmadilloBackendDefinition): ExportedHandler<ArmadilloCloudflareBindings>;
export declare const createCloudflareHandler: typeof cloudflare;
