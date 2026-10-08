import { ArmadilloFunctionError, validateFunctionInput, validateFunctionOutput } from "../backend.js";
import { INTERNAL_TABLES } from "../backend.js";
import { makeId } from "./helpers/id.js";
import { now } from "./records.js";
import { trustedGroups, trustedRecords, readTrustedFile } from "./trusted-records.js";
import {
  nextCronUtc,
  parseCron,
  sanitizeScheduleError,
  scheduleRetryDelay
} from "../schedules.js";
import { membershipsFor } from "./teams.js";
const MAX_STARTS_PER_SWEEP = 10;
const LEASE_GRACE_MS = 5e3;
async function resolveOwner(env, appId) {
  const row = await env.DB.prepare(
    `SELECT b.user_id AS user_id, u.email AS email, u.name AS name
       FROM ${INTERNAL_TABLES.bootstrap} b
       JOIN ${INTERNAL_TABLES.users} u
         ON u.app_id = b.app_id AND u.id = b.user_id
      WHERE b.app_id = ?1
      LIMIT 1`
  ).bind(appId).first();
  return row ?? null;
}
async function ensureState(env, appId, name, definition, timestamp) {
  const existing = await env.DB.prepare(
    `SELECT schedule_name, paused, next_due_at, running_at, running_run_id, pending_attempt, last_run_at
       FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND schedule_name = ?2`
  ).bind(appId, name).first();
  if (existing) return existing;
  const cron = parseCron(definition.cron);
  const timeZone = definition.timezone ?? "UTC";
  const nextDue = nextCronUtc(Date.now(), cron, timeZone);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${INTERNAL_TABLES.scheduleState}
       (app_id, schedule_name, paused, next_due_at, running_at, running_run_id, pending_attempt, last_run_at, updated_at)
     VALUES (?1, ?2, 0, ?3, NULL, NULL, 1, NULL, ?4)`
  ).bind(appId, name, nextDue, timestamp).run();
  return await env.DB.prepare(
    `SELECT schedule_name, paused, next_due_at, running_at, running_run_id, pending_attempt, last_run_at
       FROM ${INTERNAL_TABLES.scheduleState}
      WHERE app_id = ?1 AND schedule_name = ?2`
  ).bind(appId, name).first();
}
async function reapStaleLease(env, appId, name, state, definition, timestamp) {
  if (!state.running_at) return state;
  const timeoutMs = (definition.timeoutMs ?? 3e4) + LEASE_GRACE_MS;
  const started = Date.parse(state.running_at);
  if (Number.isFinite(started) && Date.now() - started < timeoutMs) return state;
  if (state.running_run_id) {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.scheduleRuns}
          SET outcome = 'timeout', finished_at = ?1,
              error_summary = COALESCE(error_summary, 'Run exceeded timeout; lease reaped.')
        WHERE app_id = ?2 AND id = ?3 AND outcome = 'running'`
    ).bind(timestamp, appId, state.running_run_id).run();
  }
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET running_at = NULL, running_run_id = NULL, updated_at = ?1
      WHERE app_id = ?2 AND schedule_name = ?3 AND running_run_id = ?4`
  ).bind(timestamp, appId, name, state.running_run_id).run();
  return { ...state, running_at: null, running_run_id: null };
}
async function claimRun(env, appId, name, state, principalType, principalId, timestamp) {
  const runId = makeId("srun");
  const attempt = state.pending_attempt || 1;
  const claimed = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET running_at = ?1, running_run_id = ?2, updated_at = ?1
      WHERE app_id = ?3 AND schedule_name = ?4
        AND paused = 0
        AND running_at IS NULL
        AND next_due_at IS NOT NULL
        AND next_due_at <= ?1`
  ).bind(timestamp, runId, appId, name).run();
  if ((claimed.meta?.changes ?? 0) < 1) return null;
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.scheduleRuns}
       (app_id, id, schedule_name, principal_type, principal_id, attempt, started_at, finished_at, outcome, error_summary, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'running', NULL, ?7)`
  ).bind(appId, runId, name, principalType, principalId, attempt, timestamp).run();
  return runId;
}
function refusedAccess() {
  throw new ArmadilloFunctionError(
    403,
    "FORBIDDEN",
    "Scheduled runs use trusted records when trusted: true; caller-scoped records/files are not available on the schedule path."
  );
}
async function invokeScheduledFunction(env, appId, backend, scheduleName, definition, fn, principal) {
  if (fn.authority === "trusted" && definition.trusted !== true) {
    throw new ArmadilloFunctionError(
      403,
      "FORBIDDEN",
      "Schedule must declare trusted: true to invoke a trusted function."
    );
  }
  if (definition.trusted === true && fn.authority !== "trusted") {
  }
  const data = await validateFunctionInput(
    fn,
    definition.data ?? {}
  );
  const actorId = principal.type === "user" ? principal.id : `schedule:${scheduleName}`;
  const groups = principal.type === "user" ? await membershipsFor(env, appId, principal.id) : [];
  const context = {
    appId,
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    functionName: definition.function,
    data,
    principal: {
      type: principal.type === "user" ? "user" : "api_key",
      id: principal.id,
      name: principal.name,
      scopes: Object.freeze(["schedule"])
    },
    user: {
      id: principal.type === "user" ? principal.id : actorId,
      email: principal.email ?? "",
      name: principal.name
    },
    groups,
    request: new Request(`https://schedule.local/v1/functions/${definition.function}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data })
    }),
    env: Object.freeze({}),
    records: {
      get: refusedAccess,
      create: refusedAccess,
      update: refusedAccess,
      delete: refusedAccess,
      query: refusedAccess
    },
    get trusted() {
      if (fn.authority !== "trusted" || definition.trusted !== true) {
        throw new ArmadilloFunctionError(
          403,
          "FORBIDDEN",
          "Raw capabilities require authority: trusted on the function and trusted: true on the schedule."
        );
      }
      return {
        db: env.DB,
        files: env.FILES,
        get users() {
          return {
            create: () => {
              throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
            },
            requestMagicLink: () => {
              throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
            },
            resetPassword: () => {
              throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
            },
            rename: () => {
              throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
            }
          };
        },
        records: trustedRecords(env, appId, backend, () => actorId),
        groups: trustedGroups(env, appId),
        readFile: (id, fileOptions) => readTrustedFile(env, appId, id, fileOptions)
      };
    },
    get db() {
      if (fn.authority !== "trusted" || definition.trusted !== true) {
        throw new ArmadilloFunctionError(403, "FORBIDDEN", "Raw capabilities require authority: trusted.");
      }
      return env.DB;
    },
    files: {
      get: refusedAccess,
      delete: refusedAccess
    },
    get users() {
      return {
        create: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
        },
        requestMagicLink: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
        },
        resetPassword: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
        },
        rename: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot administer users.");
        }
      };
    },
    emit: () => {
      throw new ArmadilloFunctionError(403, "FORBIDDEN", "Scheduled runs cannot emit realtime events in Slice 1.");
    },
    logger: {
      write(event) {
        console.log(JSON.stringify({
          timestamp: event.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
          level: event.level,
          event: event.event,
          appId: event.appId ?? appId,
          functionName: event.functionName ?? definition.function,
          scheduleName,
          actorId
        }));
      }
    },
    log: (message, details = {}) => {
      console.log(JSON.stringify({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        level: "info",
        event: message,
        appId,
        scheduleName,
        attributes: details
      }));
    },
    get trace() {
      return { traceId: "schedule", spanId: scheduleName };
    },
    span: async (_name, run) => run()
  };
  const timeoutMs = definition.timeoutMs ?? 3e4;
  let timer;
  try {
    await Promise.race([
      (async () => {
        const result = await fn.handler(context, data);
        await validateFunctionOutput(fn, result);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ArmadilloFunctionError(504, "INTERNAL_ERROR", `Schedule run exceeded ${timeoutMs}ms.`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function finishRun(env, appId, name, definition, runId, attempt, ok, errorSummary, timestamp) {
  const maxAttempts = definition.retry?.attempts ?? 1;
  let outcome = ok ? "success" : "failure";
  if (!ok && errorSummary?.includes("exceeded")) outcome = "timeout";
  const retriesLeft = !ok && attempt < maxAttempts;
  if (!ok && !retriesLeft) outcome = "dead";
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleRuns}
        SET outcome = ?1, finished_at = ?2, error_summary = ?3
      WHERE app_id = ?4 AND id = ?5`
  ).bind(outcome, timestamp, errorSummary, appId, runId).run();
  const cron = parseCron(definition.cron);
  const timeZone = definition.timezone ?? "UTC";
  let nextDue;
  let pendingAttempt;
  if (retriesLeft) {
    const delay = scheduleRetryDelay(definition.retry, attempt);
    nextDue = new Date(Date.now() + delay).toISOString().replace(/\.\d{3}Z$/, "Z");
    pendingAttempt = attempt + 1;
  } else {
    nextDue = nextCronUtc(Date.now() + 1, cron, timeZone);
    pendingAttempt = 1;
  }
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET running_at = NULL, running_run_id = NULL,
            next_due_at = ?1, pending_attempt = ?2,
            last_run_at = ?3, updated_at = ?3
      WHERE app_id = ?4 AND schedule_name = ?5`
  ).bind(nextDue, pendingAttempt, timestamp, appId, name).run();
}
async function dispatchDueSchedules(env, backend = {}) {
  const schedules = backend.schedules ?? {};
  const names = Object.keys(schedules);
  if (names.length === 0) return { started: 0, skipped: 0 };
  const appId = env.ARMADILLO_APP_ID?.trim() || "default";
  const timestamp = now();
  let started = 0;
  let skipped = 0;
  for (const name of names) {
    if (started >= MAX_STARTS_PER_SWEEP) {
      skipped += 1;
      continue;
    }
    const definition = schedules[name];
    const fn = backend.functions?.[definition.function];
    if (!fn) {
      console.warn("Armadillo schedule references missing function", { schedule: name, function: definition.function });
      skipped += 1;
      continue;
    }
    try {
      let state = await ensureState(env, appId, name, definition, timestamp);
      state = await reapStaleLease(env, appId, name, state, definition, timestamp);
      if (state.paused === 1) {
        skipped += 1;
        continue;
      }
      if (state.running_at) {
        skipped += 1;
        continue;
      }
      if (!state.next_due_at || state.next_due_at > timestamp) {
        skipped += 1;
        continue;
      }
      let principalType = "system";
      let principalId = `schedule:${name}`;
      let principalEmail = null;
      let principalName = null;
      if (definition.principal.type === "owner") {
        const owner = await resolveOwner(env, appId);
        if (!owner) {
          const runId2 = makeId("srun");
          await env.DB.prepare(
            `INSERT INTO ${INTERNAL_TABLES.scheduleRuns}
               (app_id, id, schedule_name, principal_type, principal_id, attempt, started_at, finished_at, outcome, error_summary, created_at)
             VALUES (?1, ?2, ?3, 'system', ?4, ?5, ?6, ?6, 'failure', ?7, ?6)`
          ).bind(
            appId,
            runId2,
            name,
            principalId,
            state.pending_attempt || 1,
            timestamp,
            "Owner principal unavailable; finish Burrow owner setup."
          ).run();
          await finishRun(
            env,
            appId,
            name,
            definition,
            runId2,
            state.pending_attempt || 1,
            false,
            "Owner principal unavailable; finish Burrow owner setup.",
            timestamp
          );
          started += 1;
          continue;
        }
        principalType = "user";
        principalId = owner.user_id;
        principalEmail = owner.email;
        principalName = owner.name;
      }
      const runId = await claimRun(env, appId, name, state, principalType, principalId, timestamp);
      if (!runId) {
        skipped += 1;
        continue;
      }
      started += 1;
      const attempt = state.pending_attempt || 1;
      try {
        await invokeScheduledFunction(env, appId, backend, name, definition, fn, {
          type: principalType === "user" ? "user" : "system",
          id: principalId,
          name: principalName,
          email: principalEmail
        });
        await finishRun(env, appId, name, definition, runId, attempt, true, null, now());
      } catch (error) {
        await finishRun(
          env,
          appId,
          name,
          definition,
          runId,
          attempt,
          false,
          sanitizeScheduleError(error),
          now()
        );
      }
    } catch (error) {
      console.warn("Armadillo schedule dispatch failed", {
        schedule: name,
        error: sanitizeScheduleError(error)
      });
      skipped += 1;
    }
  }
  return { started, skipped };
}
async function forceScheduleDue(env, appId, scheduleName) {
  const timestamp = now();
  const due = new Date(Date.now() - 1e3).toISOString();
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.scheduleState}
        SET next_due_at = ?1, updated_at = ?2
      WHERE app_id = ?3 AND schedule_name = ?4`
  ).bind(due, timestamp, appId, scheduleName).run();
}
export {
  dispatchDueSchedules,
  forceScheduleDue
};
