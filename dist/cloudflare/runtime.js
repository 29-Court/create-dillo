import { handleRequest } from "../engine/engine.js";
import { runScheduledSweep as sweep } from "../engine/maintenance.js";
import { consumeMailQueue } from "../engine/mail-queue.js";
import { presignR2Url } from "./r2-presign.js";
import { createRuntimeEnvironment } from "../engine/runtime.js";
import { HttpError } from "../engine/http.js";
export * from "../internal-schema.js";
import { presignR2Url as presignR2Url2 } from "./r2-presign.js";
import { ARMADILLO_VERSION } from "../engine/environment.js";
function environment(bindings, backend = {}) {
  const { DB, FILES, ARMADILLO_APP_ID, ARMADILLO_STAGE, ARMADILLO_SIGNUP_MODE, CORS_ORIGIN, ARMADILLO_REALTIME, ARMADILLO_FILE_URLS, MAIL_QUEUE, ...configuration } = bindings;
  const env = createRuntimeEnvironment({
    appId: ARMADILLO_APP_ID ?? "default",
    backend,
    database: DB,
    ...FILES ? { storage: FILES } : {},
    ...ARMADILLO_STAGE ? { stage: ARMADILLO_STAGE } : {},
    ...ARMADILLO_SIGNUP_MODE ? { signup: ARMADILLO_SIGNUP_MODE } : {},
    ...CORS_ORIGIN ? { corsOrigin: CORS_ORIGIN } : {},
    ...ARMADILLO_REALTIME ? { realtime: ARMADILLO_REALTIME } : {},
    ...ARMADILLO_FILE_URLS ? { fileUrls: ARMADILLO_FILE_URLS } : {},
    bindings: { ...configuration, ...MAIL_QUEUE ? { MAIL_QUEUE: { send: async (job) => {
      await MAIL_QUEUE.send(job);
    } } } : {} }
  });
  if (typeof FixedLengthStream !== "undefined") {
    env.ARMADILLO_UPLOAD_BODY = (request, maximum) => {
      const header = request.headers.get("content-length");
      if (header === null || !/^\d+$/.test(header)) throw new HttpError(411, "BAD_REQUEST", "Cloudflare uploads require Content-Length. Send a File, Blob, or use a signed upload URL.");
      const length = Number(header);
      if (!Number.isSafeInteger(length) || length > maximum) throw new HttpError(413, "BAD_REQUEST", "File exceeds the upload limit; use multipart upload.");
      const fixed = new FixedLengthStream(length);
      void request.body.pipeTo(fixed.writable).catch(() => void 0);
      return fixed.readable;
    };
  }
  env.ARMADILLO_STORAGE_LABELS = bindings.ARMADILLO_STORAGE_LABELS ?? ["D1", ...env.resources.files ? ["R2"] : []];
  const { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = bindings;
  if (!env.ARMADILLO_FILE_URLS && accountId && bucket && accessKeyId && secretAccessKey) {
    const credentials = { accountId, bucket, accessKeyId, secretAccessKey };
    env.ARMADILLO_FILE_URLS = {
      // Bind the declared content type into the signature so a client holding
      // this URL cannot upload a different one than Dillo recorded.
      upload: (key, contentType, expiresIn) => presignR2Url(credentials, { method: "PUT", key, expiresIn, contentType }),
      download: (key, expiresIn, options) => presignR2Url(credentials, { method: "GET", key, expiresIn, ...options })
    };
  }
  return env;
}
function handleCloudflareRequest(request, env, backend = {}) {
  return handleRequest(request, environment(env, backend), backend);
}
function runScheduledSweep(env, backend = {}) {
  return sweep(environment(env, backend), backend);
}
function cloudflare(backend = {}) {
  return {
    fetch: async (request, env) => await handleCloudflareRequest(request, env, backend),
    scheduled: (_controller, env, context) => context.waitUntil(runScheduledSweep(env, backend)),
    queue: (batch, env, context) => context.waitUntil(consumeMailQueue(batch, environment(env, backend)))
  };
}
const createCloudflareHandler = cloudflare;
export {
  ARMADILLO_VERSION,
  cloudflare,
  createCloudflareHandler,
  handleCloudflareRequest,
  presignR2Url2 as presignR2Url,
  runScheduledSweep
};
