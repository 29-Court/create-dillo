import { INTERNAL_TABLES } from "../backend.js";
import { HttpError } from "./http.js";
import { json } from "./http.js";
import { makeId } from "./helpers/id.js";
import { now } from "./records.js";
import { forceScheduleDue } from "./schedules.js";
import { nextCronUtc, parseCron } from "../schedules.js";
async function requireOperator(request, env, appId) {
  const burrow = await import("./burrow.js");
  return burrow.requireOperator(request, env, appId);
}
const RUNS_WINDOW = 50;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const RUN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
function runJson(row) {
  return {
    id: row.id,
    scheduleName: row.schedule_name,
    principalType: row.principal_type,
    principalId: row.principal_id,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    errorSummary: row.error_summary,
    createdAt: row.created_at
  };
}
async function audit(env, appId, actorId, action, subject) {
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.audit}
       (app_id, id, actor_id, action, subject, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(appId, makeId("audit"), actorId, action, subject, now()).run();
}
async function scheduleReportStrip(env, appId, definition) {
  const declared = Object.keys(definition.schedules ?? {}).length;
  const paused = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND paused = 1`
  ).bind(appId).first();
  const dead = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND outcome = 'dead'`
  ).bind(appId).first();
  const failures = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND outcome IN ('failure', 'timeout', 'dead')
        AND created_at >= datetime('now', '-1 day')`
  ).bind(appId).first();
  return {
    declared,
    paused: Number(paused?.count ?? 0),
    deadLetter: Number(dead?.count ?? 0),
    recentFailures: Number(failures?.count ?? 0)
  };
}
async function listStates(env, appId, definition) {
  const declared = definition.schedules ?? {};
  const rows = await env.DB.prepare(
    `SELECT schedule_name, paused, next_due_at, running_at, pending_attempt, last_run_at
       FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1`
  ).bind(appId).all();
  const byName = new Map((rows.results ?? []).map((r) => [r.schedule_name, r]));
  return Object.entries(declared).map(([name, def]) => {
    const state = byName.get(name);
    return {
      name,
      function: def.function,
      cron: def.cron,
      timezone: def.timezone ?? "UTC",
      principal: def.principal,
      trusted: def.trusted === true,
      overlap: def.overlap ?? "skip",
      timeoutMs: def.timeoutMs ?? 3e4,
      paused: state?.paused === 1,
      nextDueAt: state?.next_due_at ?? null,
      runningAt: state?.running_at ?? null,
      pendingAttempt: state?.pending_attempt ?? 1,
      lastRunAt: state?.last_run_at ?? null
    };
  });
}
async function listRuns(env, appId, scheduleName, outcome) {
  const params = [appId];
  const clauses = ["app_id = ?1"];
  if (scheduleName) {
    if (!NAME.test(scheduleName)) throw new HttpError(400, "BAD_REQUEST", "Invalid schedule name.");
    params.push(scheduleName);
    clauses.push(`schedule_name = ?${params.length}`);
  }
  if (outcome) {
    if (!["running", "success", "failure", "skipped", "timeout", "dead"].includes(outcome)) {
      throw new HttpError(400, "BAD_REQUEST", "Invalid outcome filter.");
    }
    params.push(outcome);
    clauses.push(`outcome = ?${params.length}`);
  }
  params.push(RUNS_WINDOW + 1);
  const result = await env.DB.prepare(
    `SELECT id, schedule_name, principal_type, principal_id, attempt, started_at, finished_at, outcome, error_summary, created_at
       FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?${params.length}`
  ).bind(...params).all();
  const rows = result.results ?? [];
  const truncated = rows.length > RUNS_WINDOW;
  const page = truncated ? rows.slice(0, RUNS_WINDOW) : rows;
  return {
    runs: page.map(runJson),
    returned: page.length,
    truncated,
    window: RUNS_WINDOW
  };
}
async function setPaused(env, appId, definition, name, paused, actorId) {
  if (!NAME.test(name) || !definition.schedules?.[name]) {
    throw new HttpError(404, "NOT_FOUND", "Schedule not found.");
  }
  const timestamp = now();
  const def = definition.schedules[name];
  const cron = parseCron(def.cron);
  const nextDue = nextCronUtc(Date.now(), cron, def.timezone ?? "UTC");
  const existing = await env.DB.prepare(
    `SELECT schedule_name, next_due_at FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND schedule_name = ?2`
  ).bind(appId, name).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.scheduleState}
         (app_id, schedule_name, paused, next_due_at, running_at, running_run_id, pending_attempt, last_run_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, 1, NULL, ?5)`
    ).bind(appId, name, paused ? 1 : 0, nextDue, timestamp).run();
  } else {
    let due = existing.next_due_at;
    if (!paused && due && due < timestamp) due = timestamp;
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.scheduleState}
          SET paused = ?1, next_due_at = ?2, updated_at = ?3
        WHERE app_id = ?4 AND schedule_name = ?5`
    ).bind(paused ? 1 : 0, due ?? nextDue, timestamp, appId, name).run();
  }
  await audit(env, appId, actorId, paused ? "burrow.schedule_paused" : "burrow.schedule_resumed", name);
  return json({ name, paused });
}
async function retryRun(env, appId, definition, runId, actorId) {
  if (!RUN_ID.test(runId)) throw new HttpError(400, "BAD_REQUEST", "Invalid run id.");
  const row = await env.DB.prepare(
    `SELECT id, schedule_name, outcome FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND id = ?2`
  ).bind(appId, runId).first();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Schedule run not found.");
  if (!definition.schedules?.[row.schedule_name]) {
    throw new HttpError(404, "NOT_FOUND", "Schedule is no longer declared.");
  }
  if (!["failure", "timeout", "dead"].includes(row.outcome)) {
    throw new HttpError(409, "CONFLICT", "Only failed, timed-out, or dead runs can be retried.");
  }
  const ts = now();
  const due = new Date(Date.now() - 1e3).toISOString();
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET next_due_at = ?1,
            pending_attempt = 1,
            running_at = NULL,
            running_run_id = NULL,
            updated_at = ?2
      WHERE app_id = ?3 AND schedule_name = ?4`
  ).bind(due, ts, appId, row.schedule_name).run();
  await forceScheduleDue(env, appId, row.schedule_name);
  await audit(env, appId, actorId, "burrow.schedule_retry", `${row.schedule_name}:${runId}`);
  return json({ scheduleName: row.schedule_name, retriedFrom: runId, due: true });
}
async function burrowSchedulesRoute(request, env, appId, definition, segments) {
  const { auth } = await requireOperator(request, env, appId);
  const leaf = segments[3];
  const action = segments[4];
  const trailing = segments[5];
  if (!leaf && request.method === "GET") {
    return json({
      schedules: await listStates(env, appId, definition),
      policy: {
        overlap: "skip",
        deadLetter: "outcome=dead after retry budget; shared operator mental model with webhook quarantine",
        dst: "Wall-clock in declared IANA timezone; skipped hours never fire; repeated hours fire once"
      }
    });
  }
  if (leaf === "runs" && !action && request.method === "GET") {
    const url = new URL(request.url);
    return json(await listRuns(
      env,
      appId,
      url.searchParams.get("schedule") ?? void 0,
      url.searchParams.get("outcome") ?? void 0
    ));
  }
  if (leaf === "runs" && action && trailing === "retry" && request.method === "POST") {
    return retryRun(env, appId, definition, action, auth.user.id);
  }
  if (leaf && action === "pause" && request.method === "POST") {
    return setPaused(env, appId, definition, leaf, true, auth.user.id);
  }
  if (leaf && action === "resume" && request.method === "POST") {
    return setPaused(env, appId, definition, leaf, false, auth.user.id);
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  burrowSchedulesRoute,
  scheduleReportStrip
};
