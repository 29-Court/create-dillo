/** User-declared schedules: cron + principal + bounded authority. */
export type SchedulePrincipal = {
    readonly type: "system";
} | {
    readonly type: "owner";
};
export type ScheduleRetryOptions = {
    readonly attempts?: number;
    readonly backoff?: "fixed" | "exponential";
    readonly initialDelayMs?: number;
};
export type ScheduleDefinition = {
    /** Name of a function in `backend.functions`. */
    readonly function: string;
    /** Standard 5-field cron: minute hour day-of-month month day-of-week. */
    readonly cron: string;
    /** IANA timezone. Default UTC. Wall-clock matching; see DST policy in docs/operations.md. */
    readonly timezone?: string;
    /** Principal the run acts as. Never ambient god-mode. */
    readonly principal: SchedulePrincipal;
    /**
     * Opt-in to invoke a function with `authority: "trusted"`.
     * A trusted function without this flag is refused (no authority escalation).
     */
    readonly trusted?: boolean;
    /** Overlap policy. Only `skip` (skip-while-running) is supported in Slice 1. */
    readonly overlap?: "skip";
    /** Hard run timeout in ms. Default 30_000; max 300_000. */
    readonly timeoutMs?: number;
    /** Retry before dead-letter. Default: one attempt (no retry). */
    readonly retry?: ScheduleRetryOptions;
    /** JSON data passed as function input. Must match the function input contract. */
    readonly data?: Record<string, unknown>;
};
export type ParsedCron = {
    readonly minute: ReadonlySet<number>;
    readonly hour: ReadonlySet<number>;
    readonly dayOfMonth: ReadonlySet<number>;
    readonly month: ReadonlySet<number>;
    readonly dayOfWeek: ReadonlySet<number>;
};
/** Parse and validate a 5-field cron. Day-of-week: 0=Sunday … 6=Saturday (7=Sunday accepted). */
export declare function parseCron(expression: string): ParsedCron;
type ZonedParts = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
};
export declare function zonedParts(date: Date, timeZone: string): ZonedParts;
/**
 * Next UTC instant (minute-aligned) at or after `fromMs` whose wall-clock in
 * `timeZone` matches `cron`. DST: skipped wall hours never match; repeated
 * hours match the first UTC minute that shows that wall time (fire once).
 */
export declare function nextCronUtc(fromMs: number, cron: ParsedCron, timeZone: string): string;
export declare function scheduleRetryDelay(retry: ScheduleRetryOptions | undefined, attemptsSoFar: number): number;
export declare function validateScheduleDefinitions(schedules: Record<string, ScheduleDefinition> | undefined, functionNames: ReadonlySet<string>): void;
/** Sanitize run error text: truncate and strip credential-shaped tokens. */
export declare function sanitizeScheduleError(error: unknown, max?: number): string;
export {};
