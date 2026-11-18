import { INTERNAL_TABLES } from "../backend.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
import type { UsageQuotas } from "../usage-config.js";
export type { UsageConfig, UsageQuotas } from "../usage-config.js";
import type { ArmadilloEnv } from "./environment.js";
import type { EngineDatabase } from "./ports.js";

type UsageDatabaseEnv = { DB: EngineDatabase };
import { HttpError } from "./http.js";

/** Metrics stored in the daily rollup ledger. Counts only — never PII or contents. */
export const USAGE_METRICS = [
  "requests",
  "records_written",
  "records_read",
  "files_stored_bytes",
  "files_served_bytes",
  "function_calls",
  "realtime_connections",
  "webhook_deliveries",
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

const METRIC_SET = new Set<string>(USAGE_METRICS);

const QUOTA_FOR_METRIC: Partial<Record<UsageMetric, keyof UsageQuotas>> = {
  requests: "requestsPerDay",
  records_written: "recordsWrittenPerDay",
  function_calls: "functionCallsPerDay",
  files_stored_bytes: "filesStoredBytesPerDay",
  files_served_bytes: "filesServedBytesPerDay",
  webhook_deliveries: "webhookDeliveriesPerDay",
  realtime_connections: "realtimeConnectionsPerDay",
};

const DAY_UTC = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` string that is also a real calendar day. */
function isRealUtcDay(value: string): boolean {
  const match = DAY_UTC.exec(value);
  if (!match) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** UTC calendar day `YYYY-MM-DD`. Day boundaries never follow app or host TZ. */
export function usageDayUtc(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight (at least 1). Used for Retry-After. */
export function secondsUntilUtcMidnight(at: Date = new Date()): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1_000));
}

/**
 * Paths that never count toward request quotas and never enforce them.
 * Operators must still recover when the app is over quota.
 */
export function isUsageExemptPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  if (segments[0] === "health") return true;
  if (segments[0] === "client.js" || segments[0] === "armadillo") return true;
  if (segments[0] === "v1" && segments[1] === "burrow") return true;
  if (segments[0] === "v1" && (segments[1] === "schema" || segments[1] === "discovery")) return true;
  return false;
}

/**
 * Billable units for `amount`. Fractional counts round up so a quota can never
 * be under-charged by a byte count that arrives as a float; nothing (zero,
 * negative, non-finite) is not billable.
 */
function billableUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(Math.ceil(amount), Number.MAX_SAFE_INTEGER);
}

/**
 * Append `amount` to today's UTC rollup. Loss-tolerant: a failed upsert is
 * logged and swallowed so metering never fails a customer request. Precision:
 * client retries after a successful response may double-count; that is stated
 * in docs/operations.md.
 *
 * Only for metrics with no configured quota. A quota'd metric goes through
 * `chargeUsage`, which is the same statement plus the ceiling.
 */
export async function recordUsage(
  env: UsageDatabaseEnv,
  appId: string,
  metric: UsageMetric,
  amount = 1,
): Promise<void> {
  const units = billableUnits(amount);
  if (units === 0) return;
  if (!METRIC_SET.has(metric)) return;
  const day = usageDayUtc();
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.usageRollups} (app_id, day_utc, metric, amount, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(app_id, day_utc, metric) DO UPDATE SET
         amount = amount + excluded.amount,
         updated_at = excluded.updated_at`,
    ).bind(appId, day, metric, units, timestamp).run();
  } catch (error) {
    console.warn("Armadillo could not record usage", {
      appId,
      metric,
      amount: units,
      error: String(error),
    });
  }
}

async function currentAmount(
  env: UsageDatabaseEnv,
  appId: string,
  metric: UsageMetric,
  day: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT amount FROM ${INTERNAL_TABLES.usageRollups}
      WHERE app_id = ?1 AND day_utc = ?2 AND metric = ?3`,
  ).bind(appId, day, metric).first<{ amount: number }>();
  return Number(row?.amount ?? 0);
}

/** A committed charge against one UTC day, releasable if the work never happened. */
export interface UsageCharge {
  readonly appId: string;
  readonly metric: UsageMetric;
  readonly dayUtc: string;
  readonly amount: number;
}

function quotaExceeded(metric: UsageMetric, limit: number, used: number): HttpError {
  const retryAfter = secondsUntilUtcMidnight();
  return new HttpError(
    429,
    "RATE_LIMITED",
    `Daily ${metric.replaceAll("_", " ")} quota reached (${limit} per UTC day). Try again after UTC midnight.`,
    { metric, retryAfter: String(retryAfter), limit: String(limit), used: String(used) },
    "Quotas reset at 00:00 UTC. Burrow and /health stay available for recovery.",
  );
}

function quotaLimit(
  definition: ArmadilloBackendDefinition,
  metric: UsageMetric,
): number | undefined {
  const key = QUOTA_FOR_METRIC[metric];
  if (!key) return undefined;
  const limit = definition.usage?.quotas?.[key];
  return typeof limit === "number" ? limit : undefined;
}

/**
 * Meter `amount` against today's rollup and hold it to the daily quota in the
 * same statement, so the check and the write cannot disagree.
 *
 * The `WHERE` on the upsert's conflict arm is what makes this a gate rather
 * than a tally: the row is left untouched and `RETURNING` yields nothing when
 * the charge would cross the ceiling, so a refused request costs nothing and
 * the refusal is decided by the database rather than by a value read earlier.
 * That matters because the rollup is per *app* — read-then-write let every
 * in-flight request pass against the same snapshot and overshoot the limit by
 * the concurrency factor, on the one surface that decides what a customer is
 * billed.
 *
 * Throws `RATE_LIMITED` 429 with fields.metric, fields.used, fields.limit and
 * fields.retryAfter. The returned charge is only needed by callers whose work
 * can fail and then must not be billed; callers that bill unconditionally
 * ignore it.
 *
 * A statement that fails to commit is *not* swallowed: a limit that cannot be
 * evaluated cannot be enforced, so the request fails instead of proceeding
 * unmetered. Metrics with no configured quota fall back to the loss-tolerant
 * `recordUsage` path.
 */
export async function chargeUsage(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  metric: UsageMetric,
  amount = 1,
): Promise<UsageCharge | undefined> {
  const units = billableUnits(amount);
  if (units === 0) return undefined;
  if (!METRIC_SET.has(metric)) return undefined;
  const limit = quotaLimit(definition, metric);
  if (limit === undefined) {
    await recordUsage(env, appId, metric, units);
    return undefined;
  }
  const day = usageDayUtc();
  const timestamp = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.usageRollups} (app_id, day_utc, metric, amount, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(app_id, day_utc, metric) DO UPDATE SET
       amount = amount + excluded.amount,
       updated_at = excluded.updated_at
     WHERE amount + excluded.amount <= ?6
     RETURNING amount`,
  ).bind(appId, day, metric, units, timestamp, limit).first<{ amount: number }>();
  if (!row) {
    const used = await currentAmount(env, appId, metric, day);
    throw quotaExceeded(metric, limit, used);
  }
  return { appId, metric, dayUtc: day, amount: units };
}

/**
 * Give back a charge whose work never happened. Keyed on the charged day, so a
 * request that straddles UTC midnight cannot debit tomorrow's quota, and
 * floored at the true total so a concurrent charge is never driven negative.
 */
export async function releaseUsage(env: UsageDatabaseEnv, charge: UsageCharge): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.usageRollups}
          SET amount = MAX(0, amount - ?1), updated_at = ?2
        WHERE app_id = ?3 AND day_utc = ?4 AND metric = ?5 AND amount > 0`,
    ).bind(charge.amount, new Date().toISOString(), charge.appId, charge.dayUtc, charge.metric).run();
  } catch (error) {
    // Never mask the failure that caused the release.
    console.warn("Armadillo could not release a usage charge", {
      appId: charge.appId,
      metric: charge.metric,
      amount: charge.amount,
      error: String(error),
    });
  }
}

/**
 * Run `work` under a quota reservation, releasing it if the work throws.
 *
 * Use this wherever the metered work can legitimately fail — a record that
 * fails validation was never written, so it must not be billed. Where the work
 * counts whether it succeeds or fails (a function invocation that ran, a
 * request that was served an error), call `chargeUsage` and keep the charge.
 */
export async function withUsageCharge<T>(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  metric: UsageMetric,
  amount: number,
  work: () => Promise<T>,
): Promise<T> {
  const charge = await chargeUsage(env, appId, definition, metric, amount);
  try {
    return await work();
  } catch (error) {
    if (charge) await releaseUsage(env, charge);
    throw error;
  }
}

/**
 * Refuse early on work whose cost is not yet known — the bytes a body will turn
 * out to be, for instance. Advisory by construction: it reads the rollup
 * without reserving, so concurrent callers can all pass it. The authoritative
 * charge happens once the real cost is known.
 */
export async function peekUsageQuota(
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  metric: UsageMetric,
  upcoming = 1,
): Promise<void> {
  const units = billableUnits(upcoming);
  if (units === 0) return;
  const limit = quotaLimit(definition, metric);
  if (limit === undefined) return;
  const day = usageDayUtc();
  const used = await currentAmount(env, appId, metric, day);
  if (used + units <= limit) return;
  throw quotaExceeded(metric, limit, used);
}

export type UsageDaySummary = {
  dayUtc: string;
  metrics: Record<string, number>;
};

/** Operator read of rollups for one app. Never includes other apps' rows. */
export async function readUsageRollups(
  env: UsageDatabaseEnv,
  appId: string,
  options: { fromDay?: string; toDay?: string; limitDays?: number } = {},
): Promise<{ days: UsageDaySummary[]; precision: string }> {
  // A shape check alone accepts 2026-02-31 and 2026-13-01, which then reach the
  // query as literals and return an empty series instead of an error.
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
  const binds: Array<string | number> = [appId];
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
      LIMIT ?${binds.length}`,
  ).bind(...binds).all<{ day_utc: string }>();

  const daysList = (dayRows.results ?? []).map((row) => row.day_utc);
  const byDay = new Map<string, Record<string, number>>();
  for (const day of daysList) byDay.set(day, {});

  if (daysList.length > 0) {
    const placeholders = daysList.map((_, index) => `?${index + 2}`).join(", ");
    const metricRows = await env.DB.prepare(
      `SELECT day_utc, metric, amount FROM ${INTERNAL_TABLES.usageRollups}
        WHERE app_id = ?1 AND day_utc IN (${placeholders})
        ORDER BY day_utc DESC, metric ASC`,
    ).bind(appId, ...daysList).all<{ day_utc: string; metric: string; amount: number }>();
    for (const row of metricRows.results ?? []) {
      const bucket = byDay.get(row.day_utc);
      if (bucket) bucket[row.metric] = Number(row.amount);
    }
  }

  return {
    days: daysList.map((dayUtc) => ({ dayUtc, metrics: byDay.get(dayUtc) ?? {} })),
    precision:
      "UTC calendar days. A metric with a configured daily quota is exact: it is charged by an atomic reserving statement, so concurrent requests cannot overshoot the limit and a refused request is not billed. A metric without a quota is best-effort — client retries after success may double-count, and a failed metering write is dropped (undercount) rather than failing the request.",
  };
}

/** Today's metrics for the Burrow report strip. */
export async function usageTodaySummary(
  env: UsageDatabaseEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<{
  dayUtc: string;
  metrics: Record<string, number>;
  quotas: UsageQuotas | null;
}> {
  const dayUtc = usageDayUtc();
  const rows = await env.DB.prepare(
    `SELECT metric, amount FROM ${INTERNAL_TABLES.usageRollups}
      WHERE app_id = ?1 AND day_utc = ?2`,
  ).bind(appId, dayUtc).all<{ metric: string; amount: number }>();
  const metrics: Record<string, number> = {};
  for (const row of rows.results ?? []) metrics[row.metric] = Number(row.amount);
  return {
    dayUtc,
    metrics,
    quotas: definition.usage?.quotas ?? null,
  };
}
