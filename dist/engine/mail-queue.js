import {} from "./environment.js";
import { INTERNAL_TABLES } from "../backend.js";
import { now } from "./records.js";
import { deliverMail } from "./mail.js";
const MAIL_QUEUE_MAX_ATTEMPTS = 5;
async function consumeMailQueue(batch, env) {
  for (const message of batch.messages) {
    const job = message.body;
    if (!job || job.version !== 1 || job.kind !== "magic_link" || !job.id || !job.appId) {
      console.error("Armadillo discarded an invalid mail queue message", { messageId: message.id });
      message.ack();
      continue;
    }
    let attempts = 0;
    try {
      const claimed = await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.mailJobs}
            SET status = 'sending', attempts = attempts + 1, updated_at = ?1
          WHERE app_id = ?2 AND id = ?3
          RETURNING attempts`
      ).bind(now(), job.appId, job.id).first();
      attempts = claimed?.attempts ?? 1;
      await deliverMail(job, env);
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.mailJobs}
            SET status = 'sent', last_error = NULL, updated_at = ?1
          WHERE app_id = ?2 AND id = ?3`
      ).bind(now(), job.appId, job.id).run();
      message.ack();
    } catch (error) {
      if (attempts === 0) {
        const row = await env.DB.prepare(
          `SELECT attempts FROM ${INTERNAL_TABLES.mailJobs} WHERE app_id = ?1 AND id = ?2`
        ).bind(job.appId, job.id).first();
        attempts = row?.attempts ?? MAIL_QUEUE_MAX_ATTEMPTS;
      }
      const exhausted = attempts >= MAIL_QUEUE_MAX_ATTEMPTS;
      const lastError = String(error).slice(0, 500);
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.mailJobs}
            SET status = ?1, last_error = ?2, updated_at = ?3
          WHERE app_id = ?4 AND id = ?5`
      ).bind(exhausted ? "failed" : "queued", lastError, now(), job.appId, job.id).run();
      if (exhausted) message.ack();
      else message.retry({ delaySeconds: 30 });
    }
  }
}
export {
  MAIL_QUEUE_MAX_ATTEMPTS,
  consumeMailQueue
};
