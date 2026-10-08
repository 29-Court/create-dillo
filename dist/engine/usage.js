import { INTERNAL_TABLES } from "../backend.js";
import { HttpError } from "./http.js";
const USAGE_METRICS = [
  "requests",
  "records_written",
  "records_read",
  "files_stored_bytes",
  "files_served_bytes",
  "function_calls",
  "realtime_connections",
  "webhook_deliveries"
];
const METRIC_SET = new Set(USAGE_METRICS);
const QUOTA_FOR_METRIC = {
  requests: "requestsPerDay",
  records_written: "recordsWrittenPerDay",
  function_calls: "functionCallsPerDay",
  files_stored_bytes: "filesStoredBytesPerDay",
  files_served_bytes: "filesServedBytesPerDay",
  webhook_deliveries: "webhookDeliveriesPerDay",
  realtime_connections: "realtimeConnectionsPerDay"
};
const DAY_UTC = /^(\d{4})-(\d{2})-(\d{2})$/;
function isRealUtcDay(value) {
  const match = DAY_UTC.exec(value);
  if (!match) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function usageDayUtc(at = /* @__PURE__ */ new Date()) {
  return at.toISOString().slice(0, 10);
}
function secondsUntilUtcMidnight(at = /* @__PURE__ */ new Date()) {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1e3));
}
function isUsageExemptPath(segments) {
  if (segments.length === 0) return true;
  if (segments[0] === "health") return true;
  if (segments[0] === "client.js" || segments[0] === "armadillo") return true;
  if (segments[0] === "v1" && segments[1] === "burrow") return true;
  if (segments[0] === "v1" && (segments[1] === "schema" || segments[1] === "discovery")) return true;
  return false;
}
function billableUnits(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(Math.ceil(amount), Number.MAX_SAFE_INTEGER);
}
async function recordUsage(env, appId, metric, amount = 1) {
  const units = billableUnits(amount);
  if (units === 0) return;
  if (!METRIC_SET.has(metric)) return;
  const day = usageDayUtc();
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.usageRollups} (app_id, day_utc, metric, amount, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(app_id, day_utc, metric) DO UPDATE SET
         amount = amount + excluded.amount,
         updated_at = excluded.updated_at`
    ).bind(appId, day, metric, units, timestamp).run();
  } catch (error) {
    console.warn("Armadillo could not record usage", {
      appId,
      metric,
      amount: units,
      error: String(error)
    });
  }
}
async function currentAmount(env, appId, metric, day) {
  const row = await env.DB.prepare(
    `SELECT amount FROM ${INTERNAL_TABLES.usageRollups}
      WHERE app_id = ?1 AND day_utc = ?2 AND metric = ?3`
  ).bind(appId, day, metric).first();
  return Number(row?.amount ?? 0);
}
function quotaExceeded(metric, limit, used) {
  const retryAfter = secondsUntilUtcMidnight();
  return new HttpError(
    429,
    "RATE_LIMITED",
    `Daily ${metric.replaceAll("_", " ")} quota reached (${limit} per UTC day). Try again after UTC midnight.`,
    { metric, retryAfter: String(retryAfter), limit: String(limit), used: String(used) },
    "Quotas reset at 00:00 UTC. Burrow and /health stay available for recovery."
  );
}
function quotaLimit(definition, metric) {
  const key = QUOTA_FOR_METRIC[metric];
  if (!key) return void 0;
  const limit = definition.usage?.quotas?.[key];
  return typeof limit === "number" ? limit : void 0;
}
async function chargeUsage(env, appId, definition, metric, amount = 1) {
  const units = billableUnits(amount);
  if (units === 0) return void 0;
  if (!METRIC_SET.has(metric)) return void 0;
  const limit = quotaLimit(definition, metric);
  if (limit === void 0) {
    await recordUsage(env, appId, metric, units);
    return void 0;
  }
  const day = usageDayUtc();
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.usageRollups} (app_id, day_utc, metric, amount, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(app_id, day_utc, metric) DO UPDATE SET
       amount = amount + excluded.amount,
       updated_at = excluded.updated_at
     WHERE amount + excluded.amount <= ?6
     RETURNING amount`
  ).bind(appId, day, metric, units, timestamp, limit).first();
  if (!row) {
    const used = await currentAmount(env, appId, metric, day);
    throw quotaExceeded(metric, limit, used);
  }
  return { appId, metric, dayUtc: day, amount: units };
}
async function releaseUsage(env, charge) {
  try {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.usageRollups}
          SET amount = MAX(0, amount - ?1), updated_at = ?2
        WHERE app_id = ?3 AND day_utc = ?4 AND metric = ?5 AND amount > 0`
    ).bind(charge.amount, (/* @__PURE__ */ new Date()).toISOString(), charge.appId, charge.dayUtc, charge.metric).run();
  } catch (error) {
    console.warn("Armadillo could not release a usage charge", {
      appId: charge.appId,
      metric: charge.metric,
      amount: charge.amount,
      error: String(error)
    });
  }
}
async function withUsageCharge(env, appId, definition, metric, amount, work) {
  const charge = await chargeUsage(env, appId, definition, metric, amount);
  try {
    return await work();
  } catch (error) {
    if (charge) await releaseUsage(env, charge);
    throw error;
  }
}
async function peekUsageQuota(env, appId, definition, metric, upcoming = 1) {
  const units = billableUnits(upcoming);
  if (units === 0) return;
  const limit = quotaLimit(definition, metric);
  if (limit === void 0) return;
  const day = usageDayUtc();
  const used = await currentAmount(env, appId, metric, day);
  if (used + units <= limit) return;
  throw quotaExceeded(metric, limit, used);
}
async function readUsageRollups(env, appId, options = {}) {
  if (options.fromDay && !isRealUtcDay(options.fromDay)) {
    throw new HttpError(422, "VALIDATION_ERROR", "from must be a real YYYY-MM-DD UTC day.", { from: "Invalid day" });
  }
  if (options.toDay && !isRealUtcDay(options.toDay)) {
    throw new HttpError(422, "VALIDATION_ERROR", "to must be a real YYYY-MM-DD UTC day.", { to: "Invalid day" });
  }
  if (options.fromDay && options.toDay && options.fromDay > options.toDay) {
    throw new HttpError(422, "VALIDATION_ERROR", "from must not be after to.", { from: "Choose an earlier day" });
  }
  const limitDays = Math.min(90, Math.max(1, options.limitDays ?? 14));
  const binds = [appId];
  let where = "app_id = ?1";
  if (options.fromDay) {
    binds.push(options.fromDay);
    where += ` AND day_utc >= ?${binds.length}`;
  }
  if (options.toDay) {
    binds.push(options.toDay);
    where += ` AND day_utc <= ?${binds.length}`;
  }
  binds.push(limitDays);
  const dayRows = await env.DB.prepare(
    `SELECT DISTINCT day_utc FROM ${INTERNAL_TABLES.usageRollups}
      WHERE ${where}
      ORDER BY day_utc DESC
      LIMIT ?${binds.length}`
  ).bind(...binds).all();
  const daysList = (dayRows.results ?? []).map((row) => row.day_utc);
  const byDay = /* @__PURE__ */ new Map();
  for (const day of daysList) byDay.set(day, {});
  if (daysList.length > 0) {
    const placeholders = daysList.map((_, index) => `?${index + 2}`).join(", ");
    const metricRows = await env.DB.prepare(
      `SELECT day_utc, metric, amount FROM ${INTERNAL_TABLES.usageRollups}
        WHERE app_id = ?1 AND day_utc IN (${placeholders})
        ORDER BY day_utc DESC, metric ASC`
    ).bind(appId, ...daysList).all();
    for (const row of metricRows.results ?? []) {
      const bucket = byDay.get(row.day_utc);
      if (bucket) bucket[row.metric] = Number(row.amount);
    }
  }
  return {
    days: daysList.map((dayUtc) => ({ dayUtc, metrics: byDay.get(dayUtc) ?? {} })),
    precision: "UTC calendar days. A metric with a configured daily quota is exact: it is charged by an atomic reserving statement, so concurrent requests cannot overshoot the limit and a refused request is not billed. A metric without a quota is best-effort \u2014 client retries after success may double-count, and a failed metering write is dropped (undercount) rather than failing the request."
  };
}
async function usageTodaySummary(env, appId, definition) {
  const dayUtc = usageDayUtc();
  const rows = await env.DB.prepare(
    `SELECT metric, amount FROM ${INTERNAL_TABLES.usageRollups}
      WHERE app_id = ?1 AND day_utc = ?2`
  ).bind(appId, dayUtc).all();
  const metrics = {};
  for (const row of rows.results ?? []) metrics[row.metric] = Number(row.amount);
  return {
    dayUtc,
    metrics,
    quotas: definition.usage?.quotas ?? null
  };
}
export {
  USAGE_METRICS,
  chargeUsage,
  isUsageExemptPath,
  peekUsageQuota,
  readUsageRollups,
  recordUsage,
  releaseUsage,
  secondsUntilUtcMidnight,
  usageDayUtc,
  usageTodaySummary,
  withUsageCharge
};
