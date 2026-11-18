import { INTERNAL_TABLES } from "../backend.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
import { HttpError } from "./http.js";
import { json } from "./http.js";
import { makeId } from "./helpers/id.js";
import { isObject } from "./helpers/json.js";
import { readJson } from "./validation.js";
import { now } from "./records.js";
import type { BindValue } from "./environment.js";

async function requireOperator(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<{ auth: { user: { id: string } } }> {
  // Lazy import avoids a circular load with burrow.ts, which mounts this route.
  const burrow = await import("./burrow.js");
  return burrow.requireOperator(request, env, appId);
}

const JOB_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const WEBHOOK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const JOBS_WINDOW = 50;
const DISCARD_REASON_MAX = 500;
/**
 * How much delivery history the webhook status report reads. The deliveries
 * table has no retention sweep, so an unbounded read turns a routine operator
 * page into a cost that grows with total application history.
 */
const WEBHOOK_REPORT_ROW_CAP = 5_000;

type JobStatus = "pending" | "delivered" | "quarantine";

interface WebhookJobRow {
  id: string;
  webhook_name: string;
  url: string;
  payload: string;
  signature: string;
  attempts: number;
  max_attempts: number;
  backoff: "fixed" | "exponential";
  initial_delay_ms: number;
  next_retry_at: string | null;
  last_status: number | null;
  last_response: string | null;
  created_at: string;
}

interface WebhookDeliveryRow {
  id: string;
  job_id: string;
  status: "success" | "failed" | "dead";
  response_status: number | null;
  response_body: string | null;
  delivered_at: string;
}

function jobStatus(row: Pick<WebhookJobRow, "next_retry_at" | "attempts" | "max_attempts">): JobStatus {
  if (row.next_retry_at !== null) return "pending";
  if (row.attempts >= row.max_attempts) return "quarantine";
  return "delivered";
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function jobSummary(row: WebhookJobRow, includePayload: boolean) {
  const status = jobStatus(row);
  return {
    id: row.id,
    webhookName: row.webhook_name,
    urlHost: urlHost(row.url),
    status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    backoff: row.backoff,
    initialDelayMs: row.initial_delay_ms,
    nextRetryAt: row.next_retry_at,
    lastStatus: row.last_status,
    lastError: row.last_response,
    createdAt: row.created_at,
    ...(includePayload ? { payload: row.payload } : {}),
  };
}

async function audit(
  env: ArmadilloEnv,
  appId: string,
  actorId: string,
  action: string,
  subject: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.audit}
       (app_id, id, actor_id, action, subject, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(appId, makeId("audit"), actorId, action, subject, now()).run();
}

async function loadJob(
  env: ArmadilloEnv,
  appId: string,
  jobId: string,
): Promise<WebhookJobRow | null> {
  return env.DB.prepare(
    `SELECT id, webhook_name, url, payload, signature, attempts, max_attempts,
            backoff, initial_delay_ms, next_retry_at, last_status, last_response, created_at
       FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, jobId).first<WebhookJobRow>();
}

/** Per-endpoint rollups a tired operator can scan. */
export async function webhookEndpointRollups(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<Array<{
  name: string;
  urlHost: string;
  delivered: number;
  failed: number;
  pending: number;
  quarantined: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}>> {
  const declared = Object.entries(definition.webhooks ?? {});
  const jobs = await env.DB.prepare(
    `SELECT id, webhook_name, url, attempts, max_attempts, next_retry_at, created_at
       FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE app_id = ?1`,
  ).bind(appId).all<Pick<WebhookJobRow, "id" | "webhook_name" | "url" | "attempts" | "max_attempts" | "next_retry_at" | "created_at">>();
  const deliveries = await env.DB.prepare(
    `SELECT d.job_id, d.status, d.delivered_at, j.webhook_name
       FROM ${INTERNAL_TABLES.webhookDeliveries} AS d
       JOIN ${INTERNAL_TABLES.webhookJobs} AS j
         ON j.app_id = d.app_id AND j.id = d.job_id
      WHERE d.app_id = ?1
      ORDER BY d.delivered_at DESC
      LIMIT ?`,
    // Bounded: nothing prunes this table, so an operator page must not load all
    // of history to render a status line.
  ).bind(appId, WEBHOOK_REPORT_ROW_CAP).all<{ job_id: string; status: string; delivered_at: string; webhook_name: string }>();

  const byName = new Map<string, {
    name: string;
    urlHost: string;
    delivered: number;
    failed: number;
    pending: number;
    quarantined: number;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
  }>();

  for (const [name, config] of declared) {
    byName.set(name, {
      name,
      urlHost: urlHost(config.url),
      delivered: 0,
      failed: 0,
      pending: 0,
      quarantined: 0,
      lastSuccessAt: null,
      consecutiveFailures: 0,
    });
  }

  for (const job of jobs.results ?? []) {
    let entry = byName.get(job.webhook_name);
    if (!entry) {
      entry = {
        name: job.webhook_name,
        urlHost: urlHost(job.url),
        delivered: 0,
        failed: 0,
        pending: 0,
        quarantined: 0,
        lastSuccessAt: null,
        consecutiveFailures: 0,
      };
      byName.set(job.webhook_name, entry);
    }
    const status = jobStatus(job);
    if (status === "pending") entry.pending += 1;
    else if (status === "quarantine") entry.quarantined += 1;
    else entry.delivered += 1;
  }

  const failedByName = new Map<string, number>();
  for (const row of deliveries.results ?? []) {
    if (row.status === "failed" || row.status === "dead") {
      failedByName.set(row.webhook_name, (failedByName.get(row.webhook_name) ?? 0) + 1);
    }
    const entry = byName.get(row.webhook_name);
    if (!entry) continue;
    if (row.status === "success" && !entry.lastSuccessAt) {
      entry.lastSuccessAt = row.delivered_at;
    }
  }
  for (const [name, count] of failedByName) {
    const entry = byName.get(name);
    if (entry) entry.failed = count;
  }

  // Consecutive failures: one pass over the newest-first delivery list, keeping a
  // per-endpoint streak until a success ends it. This used to rescan every
  // delivery for every endpoint — O(endpoints x deliveries) — over a table no
  // sweep prunes, so a caller who could cause record mutations could wedge the
  // operator's console on their own Burrow page.
  const streaks = new Map<string, { count: number; settled: boolean }>();
  for (const row of deliveries.results ?? []) {
    const state = streaks.get(row.webhook_name);
    if (!state || state.settled) continue;
    if (row.status === "success") { state.settled = true; continue; }
    state.count += 1;
  }
  for (const [name, state] of streaks) {
    const entry = byName.get(name);
    if (entry) entry.consecutiveFailures = state.count;
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function webhookQuarantineWindow(
  env: ArmadilloEnv,
  appId: string,
): Promise<{
  jobs: ReturnType<typeof jobSummary>[];
  quarantineWindow: { returned: number; total: number; truncated: boolean };
}> {
  const rows = await env.DB.prepare(
    `SELECT id, webhook_name, url, payload, signature, attempts, max_attempts,
            backoff, initial_delay_ms, next_retry_at, last_status, last_response, created_at
       FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE app_id = ?1 AND next_retry_at IS NULL AND attempts >= max_attempts
      ORDER BY created_at DESC LIMIT ${JOBS_WINDOW}`,
  ).bind(appId).all<WebhookJobRow>();
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE app_id = ?1 AND next_retry_at IS NULL AND attempts >= max_attempts`,
  ).bind(appId).first<{ total: number }>();
  const list = rows.results ?? [];
  const total = Number(totalRow?.total ?? 0);
  return {
    jobs: list.map((row) => jobSummary(row, false)),
    quarantineWindow: {
      returned: list.length,
      total,
      truncated: total > list.length,
    },
  };
}

async function listJobs(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<Response> {
  await requireOperator(request, env, appId);
  const params = new URL(request.url).searchParams;
  const statusFilter = params.get("status") ?? "all";
  if (!["all", "pending", "delivered", "quarantine"].includes(statusFilter)) {
    throw new HttpError(400, "BAD_REQUEST", "status must be all, pending, delivered, or quarantine.");
  }
  const webhook = params.get("webhook") ?? "";
  if (webhook && !WEBHOOK_NAME.test(webhook)) {
    throw new HttpError(400, "BAD_REQUEST", "webhook filter is invalid.");
  }
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get("limit") ?? "50", 10) || 50));
  const conditions = ["app_id = ?1"];
  const values: BindValue[] = [appId];
  if (webhook) {
    values.push(webhook);
    conditions.push(`webhook_name = ?${values.length}`);
  }
  if (statusFilter === "pending") {
    conditions.push("next_retry_at IS NOT NULL");
  } else if (statusFilter === "quarantine") {
    conditions.push("next_retry_at IS NULL AND attempts >= max_attempts");
  } else if (statusFilter === "delivered") {
    conditions.push("next_retry_at IS NULL AND attempts < max_attempts");
  }
  const filters = values.slice();
  filters.push(limit + 1);
  const rows = await env.DB.prepare(
    `SELECT id, webhook_name, url, payload, signature, attempts, max_attempts,
            backoff, initial_delay_ms, next_retry_at, last_status, last_response, created_at
       FROM ${INTERNAL_TABLES.webhookJobs}
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?${filters.length}`,
  ).bind(...filters).all<WebhookJobRow>();
  const page = (rows.results ?? []).slice(0, limit);
  return json({
    jobs: page.map((row) => jobSummary(row, false)),
    nextCursor: (rows.results ?? []).length > limit ? page.at(-1)?.id ?? null : null,
  });
}

async function getJob(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  jobId: string,
): Promise<Response> {
  await requireOperator(request, env, appId);
  const job = await loadJob(env, appId, jobId);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Webhook job not found.");
  const deliveries = await env.DB.prepare(
    `SELECT id, job_id, status, response_status, response_body, delivered_at
       FROM ${INTERNAL_TABLES.webhookDeliveries}
      WHERE app_id = ?1 AND job_id = ?2
      ORDER BY delivered_at DESC LIMIT 50`,
  ).bind(appId, jobId).all<WebhookDeliveryRow>();
  return json({
    job: jobSummary(job, true),
    deliveries: (deliveries.results ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      deliveredAt: row.delivered_at,
    })),
  });
}

async function replayJob(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  jobId: string,
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  const job = await loadJob(env, appId, jobId);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Webhook job not found.");
  const timestamp = now();
  const newId = makeId("webhook_job");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.webhookJobs}
         (app_id, id, webhook_name, url, payload, signature, attempts, max_attempts,
          backoff, initial_delay_ms, next_retry_at, last_status, last_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(
      appId,
      newId,
      job.webhook_name,
      job.url,
      job.payload,
      job.signature,
      job.max_attempts,
      job.backoff,
      job.initial_delay_ms,
      timestamp,
      timestamp,
    ),
  ]);
  await audit(env, appId, auth.user.id, "burrow.webhook_replay", `${jobId}->${newId}`);
  const created = await loadJob(env, appId, newId);
  if (!created) throw new HttpError(500, "INTERNAL_ERROR", "Replay job was not created.");
  return json({
    originalJobId: jobId,
    job: jobSummary(created, false),
  });
}

async function discardJob(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  jobId: string,
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  const body = await readJson(request, env);
  if (!isObject(body) || typeof body.reason !== "string") {
    throw new HttpError(422, "VALIDATION_ERROR", "Discard requires a reason.", { reason: "Required" });
  }
  const reason = body.reason.trim();
  if (!reason || reason.length > DISCARD_REASON_MAX) {
    throw new HttpError(422, "VALIDATION_ERROR", "Discard reason must be 1 to 500 characters.", {
      reason: "Invalid",
    });
  }
  const job = await loadJob(env, appId, jobId);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Webhook job not found.");
  if (jobStatus(job) !== "quarantine") {
    throw new HttpError(409, "CONFLICT", "Only quarantined (exhausted) jobs can be discarded.");
  }
  await env.DB.prepare(
    `DELETE FROM ${INTERNAL_TABLES.webhookJobs} WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, jobId).run();
  await audit(env, appId, auth.user.id, "burrow.webhook_discard", `${jobId}:${reason}`);
  return json({ discarded: true, jobId, reason });
}

async function listEndpoints(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<Response> {
  await requireOperator(request, env, appId);
  const endpoints = await webhookEndpointRollups(env, appId, definition);
  const quarantine = await webhookQuarantineWindow(env, appId);
  return json({
    endpoints,
    quarantine: quarantine.jobs,
    quarantineWindow: quarantine.quarantineWindow,
  });
}

/** Operator webhook surface under /v1/burrow/webhooks[...]. */
export async function burrowWebhooksRoute(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  segments: readonly string[],
): Promise<Response> {
  // segments: ["v1", "burrow", "webhooks", ...]
  const rest = segments.slice(3);
  if (rest.length === 0 && request.method === "GET") {
    return listEndpoints(request, env, appId, definition);
  }
  if (rest[0] === "jobs" && rest.length === 1 && request.method === "GET") {
    return listJobs(request, env, appId);
  }
  if (rest[0] === "jobs" && rest.length === 2 && typeof rest[1] === "string") {
    if (!JOB_ID.test(rest[1])) throw new HttpError(400, "BAD_REQUEST", "Webhook job id is invalid.");
    if (request.method === "GET") return getJob(request, env, appId, rest[1]);
  }
  if (rest[0] === "jobs" && rest.length === 3 && typeof rest[1] === "string" && typeof rest[2] === "string") {
    if (!JOB_ID.test(rest[1])) throw new HttpError(400, "BAD_REQUEST", "Webhook job id is invalid.");
    if (rest[2] === "replay" && request.method === "POST") return replayJob(request, env, appId, rest[1]);
    if (rest[2] === "discard" && request.method === "POST") return discardJob(request, env, appId, rest[1]);
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
