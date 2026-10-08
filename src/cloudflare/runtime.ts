import type { D1Database, R2Bucket, DurableObjectNamespace, Queue, ExportedHandler, Response as WorkerResponse } from '@cloudflare/workers-types';
import type { ArmadilloBackendDefinition } from '../backend.js';
import { handleRequest } from '../engine/engine.js';
import type { EngineEnvironment } from '../engine/environment.js';
import { runScheduledSweep as sweep } from '../engine/maintenance.js';
import { consumeMailQueue } from '../engine/mail-queue.js';
import type { MailBatch, ObjectStorage, RealtimeNamespace } from '../engine/ports.js';
import type { SendMailJob } from '../engine/mail.js';
import { presignR2Url } from './r2-presign.js';
import { createRuntimeEnvironment } from '../engine/runtime.js';
import { HttpError } from '../engine/http.js';
declare const FixedLengthStream: typeof import('@cloudflare/workers-types').FixedLengthStream;
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
function environment(bindings: ArmadilloCloudflareBindings, backend: ArmadilloBackendDefinition = {}): EngineEnvironment {
  const { DB, FILES, ARMADILLO_APP_ID, ARMADILLO_STAGE, ARMADILLO_SIGNUP_MODE, CORS_ORIGIN, ARMADILLO_REALTIME, ARMADILLO_FILE_URLS, MAIL_QUEUE, ...configuration } = bindings;
  const env = createRuntimeEnvironment({
    appId: ARMADILLO_APP_ID ?? 'default', backend, database: DB,
    ...(FILES ? { storage: FILES as unknown as ObjectStorage } : {}),
    ...(ARMADILLO_STAGE ? { stage: ARMADILLO_STAGE } : {}),
    ...(ARMADILLO_SIGNUP_MODE ? { signup: ARMADILLO_SIGNUP_MODE } : {}),
    ...(CORS_ORIGIN ? { corsOrigin: CORS_ORIGIN } : {}),
    ...(ARMADILLO_REALTIME ? { realtime: ARMADILLO_REALTIME as unknown as RealtimeNamespace } : {}),
    ...(ARMADILLO_FILE_URLS ? { fileUrls: ARMADILLO_FILE_URLS } : {}),
    bindings: { ...configuration, ...(MAIL_QUEUE ? { MAIL_QUEUE: { send: async (job) => { await MAIL_QUEUE.send(job); } } } : {}) },
  });
  if (typeof FixedLengthStream !== 'undefined') {
    env.ARMADILLO_UPLOAD_BODY = (request, maximum) => {
      const header = request.headers.get('content-length');
      if (header === null || !/^\d+$/.test(header)) throw new HttpError(411, 'BAD_REQUEST', 'Cloudflare uploads require Content-Length. Send a File, Blob, or use a signed upload URL.');
      const length = Number(header);
      if (!Number.isSafeInteger(length) || length > maximum) throw new HttpError(413, 'BAD_REQUEST', 'File exceeds the upload limit; use multipart upload.');
      // R2 rejects generic transformed streams. FixedLengthStream preserves
      // provider framing while rejecting over/under-sized request bodies.
      const fixed = new FixedLengthStream(length);
      void request.body!.pipeTo(fixed.writable as unknown as WritableStream<Uint8Array>).catch(() => undefined);
      return fixed.readable as unknown as ReadableStream<Uint8Array>;
    };
  }
  env.ARMADILLO_STORAGE_LABELS = bindings.ARMADILLO_STORAGE_LABELS ?? ["D1", ...(env.resources.files ? ["R2"] : [])];
  const { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = bindings;
  if (!env.ARMADILLO_FILE_URLS && accountId && bucket && accessKeyId && secretAccessKey) {
    const credentials = { accountId, bucket, accessKeyId, secretAccessKey };
    env.ARMADILLO_FILE_URLS = {
      // Bind the declared content type into the signature so a client holding
      // this URL cannot upload a different one than Dillo recorded.
      upload: (key, contentType, expiresIn) => presignR2Url(credentials, { method: 'PUT', key, expiresIn, contentType }),
      download: (key, expiresIn, options) => presignR2Url(credentials, { method: 'GET', key, expiresIn, ...options }),
    };
  }
  return env;
}
export function handleCloudflareRequest(request: Request, env: ArmadilloCloudflareBindings, backend: ArmadilloBackendDefinition = {}): Promise<Response> {
  return handleRequest(request, environment(env, backend), backend);
}
export function runScheduledSweep(env: ArmadilloCloudflareBindings, backend: ArmadilloBackendDefinition = {}): Promise<void> { return sweep(environment(env, backend), backend); }
export function cloudflare(backend: ArmadilloBackendDefinition = {}): ExportedHandler<ArmadilloCloudflareBindings> {
  return {
    fetch: async (request, env) => await handleCloudflareRequest(request as unknown as Request, env, backend) as unknown as WorkerResponse,
    scheduled: (_controller, env, context) => context.waitUntil(runScheduledSweep(env, backend)),
    queue: (batch, env, context) => context.waitUntil(consumeMailQueue(batch as unknown as MailBatch, environment(env, backend))),
  };
}
export const createCloudflareHandler = cloudflare;
