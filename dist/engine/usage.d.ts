import type { ArmadilloBackendDefinition } from "../backend.js";
import type { UsageQuotas } from "../usage-config.js";
export type { UsageConfig, UsageQuotas } from "../usage-config.js";
import type { ArmadilloEnv } from "./environment.js";
import type { EngineDatabase } from "./ports.js";
type UsageDatabaseEnv = {
    DB: EngineDatabase;
};
/** Metrics stored in the daily rollup ledger. Counts only — never PII or contents. */
export declare const USAGE_METRICS: readonly ["requests", "records_written", "records_read", "files_stored_bytes", "files_served_bytes", "function_calls", "realtime_connections", "webhook_deliveries"];
export type UsageMetric = (typeof USAGE_METRICS)[number];
/** UTC calendar day `YYYY-MM-DD`. Day boundaries never follow app or host TZ. */
export declare function usageDayUtc(at?: Date): string;
/** Seconds until the next UTC midnight (at least 1). Used for Retry-After. */
export declare function secondsUntilUtcMidnight(at?: Date): number;
/**
 * Paths that never count toward request quotas and never enforce them.
 * Operators must still recover when the app is over quota.
 */
export declare function isUsageExemptPath(segments: readonly string[]): boolean;
/**
 * Append `amount` to today's UTC rollup. Loss-tolerant: a failed upsert is
 * logged and swallowed so metering never fails a customer request. Precision:
 * client retries after a successful response may double-count; that is stated
 * in docs/operations.md.
 *
 * Only for metrics with no configured quota. A quota'd metric goes through
 * `chargeUsage`, which is the same statement plus the ceiling.
 */
export declare function recordUsage(env: UsageDatabaseEnv, appId: string, metric: UsageMetric, amount?: number): Promise<void>;
/** A committed charge against one UTC day, releasable if the work never happened. */
export interface UsageCharge {
    readonly appId: string;
    readonly metric: UsageMetric;
    readonly dayUtc: string;
    readonly amount: number;
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
export declare function chargeUsage(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, metric: UsageMetric, amount?: number): Promise<UsageCharge | undefined>;
/**
 * Give back a charge whose work never happened. Keyed on the charged day, so a
 * request that straddles UTC midnight cannot debit tomorrow's quota, and
 * floored at the true total so a concurrent charge is never driven negative.
 */
export declare function releaseUsage(env: UsageDatabaseEnv, charge: UsageCharge): Promise<void>;
/**
 * Run `work` under a quota reservation, releasing it if the work throws.
 *
 * Use this wherever the metered work can legitimately fail — a record that
 * fails validation was never written, so it must not be billed. Where the work
 * counts whether it succeeds or fails (a function invocation that ran, a
 * request that was served an error), call `chargeUsage` and keep the charge.
 */
export declare function withUsageCharge<T>(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, metric: UsageMetric, amount: number, work: () => Promise<T>): Promise<T>;
/**
 * Refuse early on work whose cost is not yet known — the bytes a body will turn
 * out to be, for instance. Advisory by construction: it reads the rollup
 * without reserving, so concurrent callers can all pass it. The authoritative
 * charge happens once the real cost is known.
 */
export declare function peekUsageQuota(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, metric: UsageMetric, upcoming?: number): Promise<void>;
export type UsageDaySummary = {
    dayUtc: string;
    metrics: Record<string, number>;
};
/** Operator read of rollups for one app. Never includes other apps' rows. */
export declare function readUsageRollups(env: UsageDatabaseEnv, appId: string, options?: {
    fromDay?: string;
    toDay?: string;
    limitDays?: number;
}): Promise<{
    days: UsageDaySummary[];
    precision: string;
}>;
/** Today's metrics for the Burrow report strip. */
export declare function usageTodaySummary(env: UsageDatabaseEnv, appId: string, definition: ArmadilloBackendDefinition): Promise<{
    dayUtc: string;
    metrics: Record<string, number>;
    quotas: UsageQuotas | null;
}>;
