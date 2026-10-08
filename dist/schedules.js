const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const CRON_FIELD = /^(\*(?:\/\d+)?|\d+(?:-\d+)?(?:\/\d+)?(?:,\d+(?:-\d+)?(?:\/\d+)?)*)$/;
function parseCronField(raw, min, max, label) {
  if (!CRON_FIELD.test(raw)) {
    throw new TypeError(`Cron ${label} \`${raw}\` is invalid. Use *, N, N-M, */N, or comma lists.`);
  }
  const values = /* @__PURE__ */ new Set();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === void 0 ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new TypeError(`Cron ${label} step in \`${raw}\` must be a positive integer.`);
    }
    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      start = a;
      end = b;
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
function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(
      `Cron \`${expression}\` must have exactly 5 fields (minute hour day-of-month month day-of-week).`
    );
  }
  const dayOfWeek = parseCronField(fields[4], 0, 7, "day-of-week");
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return {
    minute: parseCronField(fields[0], 0, 59, "minute"),
    hour: parseCronField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseCronField(fields[2], 1, 31, "day-of-month"),
    month: parseCronField(fields[3], 1, 12, "month"),
    dayOfWeek
  };
}
function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(/* @__PURE__ */ new Date());
  } catch {
    throw new TypeError(`Timezone \`${timeZone}\` is not a valid IANA time zone.`);
  }
}
const weekdayMap = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday] ?? 0
  };
}
function nextCronUtc(fromMs, cron, timeZone) {
  let cursor = Math.ceil(fromMs / 6e4) * 6e4;
  const limit = cursor + 366 * 24 * 60 * 6e4;
  const minutes = [...cron.minute].sort((a, b) => a - b);
  while (cursor <= limit) {
    const parts = zonedParts(new Date(cursor), timeZone);
    if (parts.second !== 0) {
      cursor += (60 - parts.second) * 1e3;
      continue;
    }
    if (!cron.month.has(parts.month) || !cron.dayOfMonth.has(parts.day) || !cron.dayOfWeek.has(parts.weekday)) {
      cursor = Math.floor(cursor / 36e5) * 36e5 + 36e5;
      continue;
    }
    if (!cron.hour.has(parts.hour)) {
      cursor = Math.floor(cursor / 36e5) * 36e5 + 36e5;
      continue;
    }
    if (!cron.minute.has(parts.minute)) {
      const nextMin = minutes.find((m) => m > parts.minute);
      if (nextMin === void 0) {
        cursor = Math.floor(cursor / 36e5) * 36e5 + 36e5;
      } else {
        cursor += (nextMin - parts.minute) * 6e4;
      }
      continue;
    }
    return new Date(cursor).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  throw new TypeError("Cron expression does not match any time in the next year.");
}
function scheduleRetryDelay(retry, attemptsSoFar) {
  const initial = retry?.initialDelayMs ?? 1e3;
  const backoff = retry?.backoff ?? "exponential";
  const multiplier = backoff === "exponential" ? 2 ** Math.max(0, attemptsSoFar - 1) : 1;
  return Math.min(initial * multiplier, 24 * 60 * 60 * 1e3);
}
function validateScheduleDefinitions(schedules, functionNames) {
  if (schedules === void 0) return;
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
        `Schedule \`${name}\` references unknown function \`${definition.function}\`. Declare it in backend.functions.`
      );
    }
    parseCron(definition.cron);
    const timeZone = definition.timezone ?? "UTC";
    assertTimeZone(timeZone);
    const principal = definition.principal;
    if (!principal || typeof principal !== "object" || principal.type !== "system" && principal.type !== "owner") {
      throw new TypeError(
        `Schedule \`${name}\` principal must be { type: "system" } or { type: "owner" }.`
      );
    }
    if (definition.trusted !== void 0 && definition.trusted !== true && definition.trusted !== false) {
      throw new TypeError(`Schedule \`${name}\` trusted must be a boolean when set.`);
    }
    if (definition.overlap !== void 0 && definition.overlap !== "skip") {
      throw new TypeError(`Schedule \`${name}\` overlap must be "skip" (Slice 1).`);
    }
    const timeout = definition.timeoutMs ?? 3e4;
    if (!Number.isSafeInteger(timeout) || timeout < 1e3 || timeout > 3e5) {
      throw new TypeError(`Schedule \`${name}\` timeoutMs must be from 1000 to 300000.`);
    }
    const attempts = definition.retry?.attempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
      throw new TypeError(`Schedule \`${name}\` retry attempts must be from 1 to 20.`);
    }
    const delay = definition.retry?.initialDelayMs ?? 1e3;
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 864e5) {
      throw new TypeError(`Schedule \`${name}\` retry initialDelayMs must be from 1 to 86400000.`);
    }
    if (definition.retry?.backoff !== void 0 && definition.retry.backoff !== "fixed" && definition.retry.backoff !== "exponential") {
      throw new TypeError(`Schedule \`${name}\` retry backoff must be "fixed" or "exponential".`);
    }
    if (definition.data !== void 0) {
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
function sanitizeScheduleError(error, max = 200) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]").replace(/(password|secret|token|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  if (message.length > max) message = `${message.slice(0, max - 1)}\u2026`;
  return message || "Schedule run failed.";
}
export {
  nextCronUtc,
  parseCron,
  sanitizeScheduleError,
  scheduleRetryDelay,
  validateScheduleDefinitions,
  zonedParts
};
