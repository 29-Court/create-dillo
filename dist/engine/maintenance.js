import {} from "./environment.js";
import { now } from "./records.js";
import { deliverWebhookJobs } from "./handlers/webhooks.js";
import { ARMADILLO_VERSION } from "./environment.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "./files.js";
import { dispatchDueSchedules } from "./schedules.js";
async function runScheduledSweep(env, backend = {}) {
  const timestamp = now();
  const cutoff = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1e3).toISOString();
  const stale = env.resources && !env.resources.files ? { results: [] } : await env.DB.prepare(
    `SELECT app_id, id, owner_id, storage_key, name, content_type, expected_size, kind,
            r2_upload_id, status, created_at, expires_at
       FROM ${INTERNAL_TABLES.fileUploads}
      WHERE status = 'pending' AND expires_at <= ?1 LIMIT 100`
  ).bind(timestamp).all();
  for (const upload of stale.results ?? []) {
    try {
      if (upload.kind === "multipart" && upload.r2_upload_id) {
        await env.FILES.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id).abort();
      } else {
        await env.FILES.delete(upload.storage_key);
      }
      await env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.fileUploads} WHERE app_id = ? AND id = ? AND status = 'pending'`
      ).bind(upload.app_id, upload.id).run();
    } catch (error) {
      console.warn("Armadillo could not abort an expired upload", { uploadId: upload.id, error: String(error) });
    }
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.sessions} WHERE expires_at <= ?1`).bind(timestamp),
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.bootstrapSessions} WHERE expires_at <= ?1`).bind(timestamp),
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.oauthStates} WHERE expires_at <= ?1`).bind(timestamp),
    // Cutoffs are computed in JS and bound as ISO strings. SQLite's `datetime()`
    // emits "YYYY-MM-DD HH:MM:SS", which sorts *before* every stored ISO
    // timestamp at the separator, so these predicates silently matched nothing.
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.magicLinks}
        WHERE expires_at <= ?1 OR (consumed_at IS NOT NULL AND consumed_at <= ?2)`
    ).bind(timestamp, cutoff(1)),
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.rateLimits} WHERE reset_at <= ?1`).bind(timestamp),
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.mailJobs}
        WHERE updated_at <= ?2 AND status IN ('sent', 'failed')`
    ).bind(timestamp, cutoff(30)),
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.collectorSubmissions} WHERE expires_at <= ?1`
    ).bind(timestamp),
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.realtimeConnections}
        WHERE last_heartbeat <= ?2`
    ).bind(timestamp, cutoff(1)),
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.gdprConsents} WHERE expires_at IS NOT NULL AND expires_at <= ?1`).bind(timestamp),
    env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.gdprExportLog} WHERE expires_at <= ?1`).bind(timestamp)
  ]);
  await deliverWebhookJobs(env, timestamp, ARMADILLO_VERSION);
  await dispatchDueSchedules(env, backend);
}
export {
  runScheduledSweep
};
