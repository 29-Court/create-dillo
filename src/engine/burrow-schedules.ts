import { INTERNAL_TABLES } from "../backend.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
import { HttpError } from "./http.js";
import { json } from "./http.js";
import { makeId } from "./helpers/id.js";
import { now } from "./records.js";
import { forceScheduleDue } from "./schedules.js";
import { nextCronUtc, parseCron } from "../schedules.js";

async function requireOperator(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<{ auth: { user: { id: string } } }> {
  const burrow = await import("./burrow.js");
  return burrow.requireOperator(request, env, appId);
}

const RUNS_WINDOW = 50;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const RUN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

type StateRow = {
  schedule_name: string;
  paused: number;
  next_due_at: string | null;
  running_at: string | null;
  pending_attempt: number;
  last_run_at: string | null;
};

type RunRow = {
  id: string;
  schedule_name: string;
  principal_type: string;
  principal_id: string;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  error_summary: string | null;
  created_at: string;
};

function runJson(row: RunRow) {
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
    createdAt: row.created_at,
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

/** Compact strip for the Burrow report — counts only, no error text with possible content. */
export async function scheduleReportStrip(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<{
  declared: number;
  paused: number;
  deadLetter: number;
  recentFailures: number;
}> {
  const declared = Object.keys(definition.schedules ?? {}).length;
  const paused = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND paused = 1`,
  ).bind(appId).first<{ count: number }>();
  const dead = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND outcome = 'dead'`,
  ).bind(appId).first<{ count: number }>();
  const failures = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND outcome IN ('failure', 'timeout', 'dead')
        AND created_at >= datetime('now', '-1 day')`,
  ).bind(appId).first<{ count: number }>();
  return {
    declared,
    paused: Number(paused?.count ?? 0),
    deadLetter: Number(dead?.count ?? 0),
    recentFailures: Number(failures?.count ?? 0),
  };
}

async function listStates(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
) {
  const declared = definition.schedules ?? {};
  const rows = await env.DB.prepare(
    `SELECT schedule_name, paused, next_due_at, running_at, pending_attempt, last_run_at
       FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1`,
  ).bind(appId).all<StateRow>();
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
      timeoutMs: def.timeoutMs ?? 30_000,
      paused: state?.paused === 1,
      nextDueAt: state?.next_due_at ?? null,
      runningAt: state?.running_at ?? null,
      pendingAttempt: state?.pending_attempt ?? 1,
      lastRunAt: state?.last_run_at ?? null,
    };
  });
}

async function listRuns(
  env: ArmadilloEnv,
  appId: string,
  scheduleName: string | undefined,
  outcome: string | undefined,
) {
  const params: Array<string | number> = [appId];
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
      LIMIT ?${params.length}`,
  ).bind(...params).all<RunRow>();
  const rows = result.results ?? [];
  const truncated = rows.length > RUNS_WINDOW;
  const page = truncated ? rows.slice(0, RUNS_WINDOW) : rows;
  return {
    runs: page.map(runJson),
    returned: page.length,
    truncated,
    window: RUNS_WINDOW,
  };
}

async function setPaused(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  name: string,
  paused: boolean,
  actorId: string,
): Promise<Response> {
  if (!NAME.test(name) || !definition.schedules?.[name]) {
    throw new HttpError(404, "NOT_FOUND", "Schedule not found.");
  }
  const timestamp = now();
  const def = definition.schedules[name]!;
  // Ensure state row exists so pause sticks before first dispatch.
  const cron = parseCron(def.cron);
  const nextDue = nextCronUtc(Date.now(), cron, def.timezone ?? "UTC");
  const existing = await env.DB.prepare(
    `SELECT schedule_name, next_due_at FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND schedule_name = ?2`,
  ).bind(appId, name).first<{ schedule_name: string; next_due_at: string | null }>();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.scheduleState}
         (app_id, schedule_name, paused, next_due_at, running_at, running_run_id, pending_attempt, last_run_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, 1, NULL, ?5)`,
    ).bind(appId, name, paused ? 1 : 0, nextDue, timestamp).run();
  } else {
    // On resume, do not backfill skipped fires — jump next_due to now if it lagged.
    let due = existing.next_due_at;
    if (!paused && due && due < timestamp) due = timestamp;
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.scheduleState}
          SET paused = ?1, next_due_at = ?2, updated_at = ?3
        WHERE app_id = ?4 AND schedule_name = ?5`,
    ).bind(paused ? 1 : 0, due ?? nextDue, timestamp, appId, name).run();
  }
  await audit(env, appId, actorId, paused ? "burrow.schedule_paused" : "burrow.schedule_resumed", name);
  return json({ name, paused });
}

async function retryRun(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  runId: string,
  actorId: string,
): Promise<Response> {
  if (!RUN_ID.test(runId)) throw new HttpError(400, "BAD_REQUEST", "Invalid run id.");
  const row = await env.DB.prepare(
    `SELECT id, schedule_name, outcome FROM ${INTERNAL_TABLES.scheduleRuns}
      WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, runId).first<{ id: string; schedule_name: string; outcome: string }>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Schedule run not found.");
  if (!definition.schedules?.[row.schedule_name]) {
    throw new HttpError(404, "NOT_FOUND", "Schedule is no longer declared.");
  }
  if (!["failure", "timeout", "dead"].includes(row.outcome)) {
    throw new HttpError(409, "CONFLICT", "Only failed, timed-out, or dead runs can be retried.");
  }
  const ts = now();
  const due = new Date(Date.now() - 1_000).toISOString();
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET next_due_at = ?1,
            pending_attempt = 1,
            running_at = NULL,
            running_run_id = NULL,
            updated_at = ?2
      WHERE app_id = ?3 AND schedule_name = ?4`,
  ).bind(due, ts, appId, row.schedule_name).run();
  // Ensure state exists even if never dispatched.
  await forceScheduleDue(env, appId, row.schedule_name);
  await audit(env, appId, actorId, "burrow.schedule_retry", `${row.schedule_name}:${runId}`);
  return json({ scheduleName: row.schedule_name, retriedFrom: runId, due: true });
}

export async function burrowSchedulesRoute(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  segments: readonly string[],
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  // /v1/burrow/schedules
  // /v1/burrow/schedules/runs
  // /v1/burrow/schedules/:name/pause|resume
  // /v1/burrow/schedules/runs/:id/retry
  const leaf = segments[3];
  const action = segments[4];
  const trailing = segments[5];

  if (!leaf && request.method === "GET") {
    return json({
      schedules: await listStates(env, appId, definition),
      policy: {
        overlap: "skip",
        deadLetter: "outcome=dead after retry budget; shared operator mental model with webhook quarantine",
        dst: "Wall-clock in declared IANA timezone; skipped hours never fire; repeated hours fire once",
      },
    });
  }

  if (leaf === "runs" && !action && request.method === "GET") {
    const url = new URL(request.url);
    return json(await listRuns(
      env,
      appId,
      url.searchParams.get("schedule") ?? undefined,
      url.searchParams.get("outcome") ?? undefined,
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
