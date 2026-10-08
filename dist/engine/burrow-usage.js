import { HttpError, json } from "./http.js";
import { makeId } from "./helpers/id.js";
import { INTERNAL_TABLES } from "../backend.js";
import { now } from "./records.js";
import { readUsageRollups, usageTodaySummary } from "./usage.js";
async function requireOperator(request, env, appId) {
  const burrow = await import("./burrow.js");
  return burrow.requireOperator(request, env, appId);
}
async function audit(env, appId, actorId, action, subject) {
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.audit}
       (app_id, id, actor_id, action, subject, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(appId, makeId("audit"), actorId, action, subject, now()).run();
}
async function burrowUsageRoute(request, env, appId, definition, segments) {
  if (segments.length !== 3 || request.method !== "GET") {
    throw new HttpError(404, "NOT_FOUND", "Route not found.");
  }
  const { auth } = await requireOperator(request, env, appId);
  const params = new URL(request.url).searchParams;
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const limitRaw = params.get("days");
  const limitDays = limitRaw ? Number.parseInt(limitRaw, 10) : void 0;
  if (limitRaw && (!Number.isSafeInteger(limitDays) || (limitDays ?? 0) < 1)) {
    throw new HttpError(422, "VALIDATION_ERROR", "days must be a positive integer.", { days: "Invalid" });
  }
  const rollups = await readUsageRollups(env, appId, {
    ...fromParam ? { fromDay: fromParam } : {},
    ...toParam ? { toDay: toParam } : {},
    ...limitDays !== void 0 ? { limitDays } : {}
  });
  const today = await usageTodaySummary(env, appId, definition);
  await audit(env, appId, auth.user.id, "burrow.usage_read", today.dayUtc);
  return json({
    today,
    days: rollups.days,
    precision: rollups.precision,
    metrics: [
      "requests",
      "records_written",
      "records_read",
      "files_stored_bytes",
      "files_served_bytes",
      "function_calls",
      "realtime_connections",
      "webhook_deliveries"
    ]
  });
}
export {
  burrowUsageRoute
};
