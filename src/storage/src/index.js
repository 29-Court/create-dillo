'use strict';
/** StoragePort factory: backend selection is ONE environment value (§2.4). */
const { MemoryBackend } = require('./memory-backend');
const { D1BlobBackend } = require('./d1-backend');
const { R2Backend } = require('./r2-backend');
const port = require('./storage-port');

function createStorageBackend(env = process.env, opts = {}) {
  const kind = (env.PLATFORM_STORAGE_BACKEND || 'd1').toLowerCase();
  if (kind === 'd1') return new D1BlobBackend();
  if (kind === 'memory') return new MemoryBackend();
  if (kind === 'r2') {
    const bucket = env.PLATFORM_R2_BUCKET || '29court-app-files';
    // Production: a Worker R2Bucket binding, passed in by the Worker host
    // (bindings cannot travel in env). Local dev / tests: S3-compatible
    // endpoint + credentials from env only — never a literal value here.
    if (opts.binding) return new R2Backend({ binding: opts.binding, bucket });
    if (env.PLATFORM_R2_ENDPOINT) {
      return new R2Backend({
        endpoint: env.PLATFORM_R2_ENDPOINT, bucket,
        accessKeyId: env.PLATFORM_R2_ACCESS_KEY_ID,
        secretAccessKey: env.PLATFORM_R2_SECRET_ACCESS_KEY,
        region: env.PLATFORM_R2_REGION || 'auto',
      });
    }
    // No transport configured: the backend constructs but every method
    // throws NotProvisioned (AT-1: no R2 permission on the fleet token,
    // no provisioned bucket) instead of silently writing nowhere.
    return new R2Backend({ bucket });
  }
  throw new port.ValidationError(`unknown PLATFORM_STORAGE_BACKEND '${kind}' (expected d1|memory|r2)`);
}
module.exports = { createStorageBackend, MemoryBackend, D1BlobBackend, R2Backend, ...port };
