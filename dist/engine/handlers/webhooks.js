import {
  buildWebhookJobs,
  webhookRetryDelay
} from "../../index.js";
import {
  INTERNAL_TABLES
} from "../../backend.js";
import { makeId } from "../helpers/id.js";
import { recordUsage } from "../usage.js";
async function prepareWebhookEvent(env, currentAppId, options, name, data, actorId) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const event = {
    id: makeId("webhook_event"),
    name,
    appId: currentAppId,
    data,
    ...actorId ? { actorId } : {},
    timestamp
  };
  const jobs = await buildWebhookJobs(options.webhooks, event, env);
  return jobs.map((job) => env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.webhookJobs}
       (app_id, id, webhook_name, url, payload, signature, attempts, max_attempts,
        backoff, initial_delay_ms, next_retry_at, last_status, last_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?)`
  ).bind(
    currentAppId,
    makeId("webhook_job"),
    job.webhookName,
    job.url,
    job.payload,
    job.signature,
    job.maxAttempts,
    job.backoff,
    job.initialDelayMs,
    timestamp,
    timestamp
  ));
}
async function enqueueWebhookEvent(...args) {
  const statements = await prepareWebhookEvent(...args);
  if (statements.length) await args[0].DB.batch(statements);
}
async function responsePrefix(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let remaining = 2e3;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      remaining -= chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  const bytes = new Uint8Array(2e3 - remaining);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
async function deliverWebhookJobs(env, timestamp, version, fetcher = fetch) {
  const jobs = await env.DB.prepare(
    `SELECT app_id, id, webhook_name, url, payload, signature, attempts, max_attempts,
            backoff, initial_delay_ms, created_at
       FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE next_retry_at IS NOT NULL AND next_retry_at <= ? AND attempts < max_attempts
      ORDER BY next_retry_at ASC LIMIT 50`
  ).bind(timestamp).all();
  const deadline = Date.now() + 2e4;
  for (const job of jobs.results ?? []) {
    if (Date.now() >= deadline) break;
    const lease = new Date(Date.now() + 6e4).toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.webhookJobs} SET next_retry_at = ?
       WHERE app_id = ? AND id = ? AND next_retry_at <= ? AND attempts = ?
       RETURNING id`
    ).bind(lease, job.app_id, job.id, timestamp, job.attempts).first();
    if (!claimed) continue;
    let responseStatus = null;
    let responseBody = "";
    let success = false;
    try {
      const response = await fetcher(job.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": `Armadillo/${version}`,
          "x-armadillo-signature": job.signature,
          "x-armadillo-delivery": job.id,
          // The signature covers this timestamp, so a receiver can bound how old
          // a delivery is instead of accepting a replayed pair forever.
          ...job.created_at ? { "x-armadillo-timestamp": job.created_at } : {}
        },
        body: job.payload,
        signal: AbortSignal.timeout(Math.max(1, Math.min(5e3, deadline - Date.now())))
      });
      responseStatus = response.status;
      responseBody = await responsePrefix(response);
      success = response.ok;
    } catch (error) {
      responseBody = error instanceof Error ? error.message.slice(0, 2e3) : String(error).slice(0, 2e3);
    }
    const attempts = job.attempts + 1;
    const dead = !success && attempts >= job.max_attempts;
    const nextRetryAt = success || dead ? null : new Date(Date.now() + webhookRetryDelay({
      initialDelayMs: job.initial_delay_ms,
      backoff: job.backoff
    }, attempts)).toISOString();
    const deliveredAt = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.webhookJobs}
            SET attempts = ?, next_retry_at = ?, last_status = ?, last_response = ?
          WHERE app_id = ? AND id = ? AND next_retry_at = ?`
      ).bind(attempts, nextRetryAt, responseStatus, responseBody, job.app_id, job.id, lease),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.webhookDeliveries}
           (app_id, id, job_id, status, response_status, response_body, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        job.app_id,
        makeId("webhook_delivery"),
        job.id,
        success ? "success" : dead ? "dead" : "failed",
        responseStatus,
        responseBody,
        deliveredAt
      )
    ]);
    if (success) await recordUsage(env, job.app_id, "webhook_deliveries");
  }
}
export {
  deliverWebhookJobs,
  enqueueWebhookEvent,
  prepareWebhookEvent
};
