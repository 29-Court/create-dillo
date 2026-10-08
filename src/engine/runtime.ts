import type { RuntimeOptions } from '../runtime.js';
import type { EngineEnvironment } from './environment.js';
import type { EngineDatabase, ObjectStorage, RealtimeNamespace } from './ports.js';
import { appCapabilities } from '../capabilities.js';
import { HttpError } from './http.js';

/** One application's owned capabilities; provider handles stop at the adapter. */
export interface ArmadilloResources {
  readonly appId: string;
  readonly stage: string;
  readonly db: EngineDatabase;
  readonly files?: ObjectStorage;
  readonly realtime?: RealtimeNamespace;
  readonly mailQueue?: NonNullable<EngineEnvironment['MAIL_QUEUE']>;
}

function unavailable(): never {
  throw new HttpError(503, 'INTERNAL_ERROR', 'Files are not enabled for this application.');
}
// Compatibility bridge for existing engine services. Never silently discard writes.
const disabledFiles: ObjectStorage = Object.freeze({
  get: unavailable, head: unavailable, put: unavailable, delete: unavailable,
  createMultipartUpload: unavailable, resumeMultipartUpload: unavailable,
});

export function createRuntimeEnvironment(options: RuntimeOptions): EngineEnvironment & { resources: ArmadilloResources } {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(options.appId)) throw new TypeError('Runtime appId must be a valid application name.');
  if (typeof options.database?.prepare !== 'function' || typeof options.database.batch !== 'function') {
    throw new TypeError('Runtime database requires prepare() and atomic batch().');
  }
  const capabilities = appCapabilities(options.backend);
  if (capabilities.files) {
    for (const key of ['get', 'head', 'put', 'delete', 'createMultipartUpload', 'resumeMultipartUpload'] as const) {
      if (typeof options.storage?.[key] !== 'function') throw new TypeError(`Runtime storage requires ${key}().`);
    }
  }
  for (const key of ['resources', 'DB', 'FILES', 'ARMADILLO_APP_ID', 'ARMADILLO_STAGE', 'ARMADILLO_SIGNUP_MODE', 'CORS_ORIGIN', 'ARMADILLO_REALTIME', 'ARMADILLO_FILE_URLS']) {
    if (key in (options.bindings ?? {})) throw new TypeError(`Runtime binding ${key} is configured through its named option.`);
  }
  const resources: ArmadilloResources = Object.freeze({
    appId: options.appId,
    stage: options.stage ?? 'custom',
    db: options.database,
    ...(capabilities.files && options.storage ? { files: options.storage } : {}),
    ...(options.realtime ? { realtime: options.realtime } : {}),
    ...(options.bindings?.MAIL_QUEUE ? { mailQueue: options.bindings.MAIL_QUEUE } : {}),
  });
  return {
    ...options.bindings,
    resources,
    DB: resources.db,
    FILES: resources.files ?? disabledFiles,
    ARMADILLO_APP_ID: resources.appId,
    ARMADILLO_STAGE: resources.stage,
    ARMADILLO_SIGNUP_MODE: options.signup ?? 'closed',
    CORS_ORIGIN: options.corsOrigin ?? '*',
    ...(resources.realtime ? { ARMADILLO_REALTIME: resources.realtime } : {}),
    ...(options.fileUrls ? { ARMADILLO_FILE_URLS: options.fileUrls } : {}),
  };
}
