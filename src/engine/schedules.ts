/** User-declared schedules: cron + principal + bounded authority. */

export type SchedulePrincipal =
  | { readonly type: "system" }
  | { readonly type: "owner" };

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

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const CRON_FIELD = /^(\*(?:\/\d+)?|\d+(?:-\d+)?(?:\/\d+)?(?:,\d+(?:-\d+)?(?:\/\d+)?)*)$/;

function parseCronField(raw: string, min: number, max: number, label: string): Set<number> {
  if (!CRON_FIELD.test(raw)) {
    throw new TypeError(`Cron ${label} \`${raw}\` is invalid. Use *, N, N-M, */N, or comma lists.`);
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new TypeError(`Cron ${label} step in \`${raw}\` must be a positive integer.`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-").map(Number);
      start = a!;
      end = b!;
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (![start, end].every((n) => Number.isSafeInteger(n) && n >= min && n <= max) || start > end) {
      throw new TypeError(`Cron ${label} \`${raw}\` is out of range ${min}-${max}.`);
    }
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}

export type ParsedCron = {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
};

/** Parse and validate a 5-field cron. Day-of-week: 0=Sunday … 6=Saturday (7=Sunday accepted). */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(
      `Cron \`${expression}\` must have exactly 5 fields (minute hour day-of-month month day-of-week).`,
    );
  }
  const dayOfWeek = parseCronField(fields[4]!, 0, 7, "day-of-week");
  // Normalize 7 → 0 (Sunday).
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return {
    minute: parseCronField(fields[0]!, 0, 59, "minute"),
    hour: parseCronField(fields[1]!, 0, 23, "hour"),
    dayOfMonth: parseCronField(fields[2]!, 1, 31, "day-of-month"),
    month: parseCronField(fields[3]!, 1, 12, "month"),
    dayOfWeek,
  };
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new TypeError(`Timezone \`${timeZone}\` is not a valid IANA time zone.`);
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun
};

const weekdayMap: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday!] ?? 0,
  };
}

/**
 * Next UTC instant (minute-aligned) at or after `fromMs` whose wall-clock in
 * `timeZone` matches `cron`. DST: skipped wall hours never match; repeated
 * hours match the first UTC minute that shows that wall time (fire once).
 */
export function nextCronUtc(fromMs: number, cron: ParsedCron, timeZone: string): string {
  // Ceil to the next whole minute so we never re-fire the same minute.
  let cursor = Math.ceil(fromMs / 60_000) * 60_000;
  const limit = cursor + 366 * 24 * 60 * 60_000;
  const minutes = [...cron.minute].sort((a, b) => a - b);
  while (cursor <= limit) {
    const parts = zonedParts(new Date(cursor), timeZone);
    if (parts.second !== 0) {
      cursor += (60 - parts.second) * 1_000;
      continue;
    }
    if (!cron.month.has(parts.month) || !cron.dayOfMonth.has(parts.day) || !cron.dayOfWeek.has(parts.weekday)) {
      // Jump to the next UTC hour boundary to cut work on sparse calendars.
      cursor = Math.floor(cursor / 3_600_000) * 3_600_000 + 3_600_000;
      continue;
    }
    if (!cron.hour.has(parts.hour)) {
      cursor = Math.floor(cursor / 3_600_000) * 3_600_000 + 3_600_000;
      continue;
    }
    if (!cron.minute.has(parts.minute)) {
      const nextMin = minutes.find((m) => m > parts.minute);
      if (nextMin === undefined) {
        cursor = Math.floor(cursor / 3_600_000) * 3_600_000 + 3_600_000;
      } else {
        cursor += (nextMin - parts.minute) * 60_000;
      }
      continue;
    }
    return new Date(cursor).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  throw new TypeError("Cron expression does not match any time in the next year.");
}

export function scheduleRetryDelay(
  retry: ScheduleRetryOptions | undefined,
  attemptsSoFar: number,
): number {
  const initial = retry?.initialDelayMs ?? 1_000;
  const backoff = retry?.backoff ?? "exponential";
  const multiplier = backoff === "exponential" ? 2 ** Math.max(0, attemptsSoFar - 1) : 1;
  return Math.min(initial * multiplier, 24 * 60 * 60 * 1_000);
}

export function validateScheduleDefinitions(
  schedules: Record<string, ScheduleDefinition> | undefined,
  functionNames: ReadonlySet<string>,
): void {
  if (schedules === undefined) return;
  if (schedules === null || typeof schedules !== "object" || Array.isArray(schedules)) {
    throw new TypeError("schedules must be an object when provided.");
  }
  for (const [name, definition] of Object.entries(schedules)) {
    if (!NAME.test(name)) {
      throw new TypeError(`Schedule name \`${name}\` is invalid.`);
    }
    if (!definition || typeof definition !== "object") {
      throw new TypeError(`Schedule \`${name}\` must be an object.`);
    }
    if (typeof definition.function !== "string" || !NAME.test(definition.function)) {
      throw new TypeError(`Schedule \`${name}\` needs a valid function name.`);
    }
    if (!functionNames.has(definition.function)) {
      throw new TypeError(
        `Schedule \`${name}\` references unknown function \`${definition.function}\`. Declare it in backend.functions.`,
      );
    }
    parseCron(definition.cron);
    const timeZone = definition.timezone ?? "UTC";
    assertTimeZone(timeZone);
    const principal = definition.principal;
    if (
      !principal
      || typeof principal !== "object"
      || (principal.type !== "system" && principal.type !== "owner")
    ) {
      throw new TypeError(
        `Schedule \`${name}\` principal must be { type: "system" } or { type: "owner" }.`,
      );
    }
    if (definition.trusted !== undefined && definition.trusted !== true && definition.trusted !== false) {
      throw new TypeError(`Schedule \`${name}\` trusted must be a boolean when set.`);
    }
    if (definition.overlap !== undefined && definition.overlap !== "skip") {
      throw new TypeError(`Schedule \`${name}\` overlap must be "skip" (Slice 1).`);
    }
    const timeout = definition.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
      throw new TypeError(`Schedule \`${name}\` timeoutMs must be from 1000 to 300000.`);
    }
    const attempts = definition.retry?.attempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
      throw new TypeError(`Schedule \`${name}\` retry attempts must be from 1 to 20.`);
    }
    const delay = definition.retry?.initialDelayMs ?? 1_000;
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 86_400_000) {
      throw new TypeError(`Schedule \`${name}\` retry initialDelayMs must be from 1 to 86400000.`);
    }
    if (
      definition.retry?.backoff !== undefined
      && definition.retry.backoff !== "fixed"
      && definition.retry.backoff !== "exponential"
    ) {
      throw new TypeError(`Schedule \`${name}\` retry backoff must be "fixed" or "exponential".`);
    }
    if (definition.data !== undefined) {
      if (!definition.data || typeof definition.data !== "object" || Array.isArray(definition.data)) {
        throw new TypeError(`Schedule \`${name}\` data must be a plain object when set.`);
      }
      try {
        JSON.stringify(definition.data);
      } catch {
        throw new TypeError(`Schedule \`${name}\` data must be JSON-serializable.`);
      }
    }
  }
}

/** Sanitize run error text: truncate and strip credential-shaped tokens. */
export function sanitizeScheduleError(error: unknown, max = 200): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(password|secret|token|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  if (message.length > max) message = `${message.slice(0, max - 1)}…`;
  return message || "Schedule run failed.";
}
