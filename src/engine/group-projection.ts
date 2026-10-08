import { INTERNAL_TABLES } from "../internal-schema.js";
import type { SchemaDefinition } from "../schema.js";
import type { ArmadilloEnv } from "./environment.js";
import { FIELD } from "./http.js";

// One running server has one database per application id.
const ready = new Map<string, string>();

/** @internal Clears the process cache so the next request reads the projection table. */
export function forgetGroupProjection(appId?: string): void {
  if (appId === undefined) ready.clear();
  else ready.delete(appId);
}

function teamFields(schema: SchemaDefinition | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [collection, table] of Object.entries(schema?.normalized.tables ?? {})) {
    if (table.storage !== "json" || !table.team || !FIELD.test(table.team.field)) continue;
    pairs.push([collection, table.team.field]);
  }
  pairs.sort(([left], [right]) => left.localeCompare(right));
  return pairs;
}

/** Copy each JSON team pointer into group_id once per schema. */
export async function ensureGroupProjection(
  env: ArmadilloEnv,
  appId: string,
  schema: SchemaDefinition | undefined,
): Promise<void> {
  const desired = teamFields(schema);
  const key = desired.map(([collection, field]) => `${collection}:${field}`).join(",");
  if (ready.get(appId) === key) return;
  const stored = await env.DB.prepare(
    `SELECT collection, field FROM ${INTERNAL_TABLES.groupProjection} WHERE app_id = ?`,
  ).bind(appId).all<{ collection: string; field: string }>();
  const have = new Map((stored.results ?? []).map((row) => [row.collection, row.field]));
  const want = new Map(desired);
  for (const [collection, field] of want) {
    if (have.get(collection) === field) continue;
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.objects}
          SET group_id = json_extract(data, '$.${field}')
        WHERE app_id = ? AND collection = ?
          AND group_id IS NOT json_extract(data, '$.${field}')`,
    ).bind(appId, collection).run();
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.groupProjection} (app_id, collection, field)
       VALUES (?, ?, ?)
       ON CONFLICT (app_id, collection) DO UPDATE SET field = excluded.field`,
    ).bind(appId, collection, field).run();
  }
  for (const collection of have.keys()) {
    if (want.has(collection)) continue;
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.objects}
          SET group_id = NULL
        WHERE app_id = ? AND collection = ? AND group_id IS NOT NULL`,
    ).bind(appId, collection).run();
    await env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.groupProjection} WHERE app_id = ? AND collection = ?`,
    ).bind(appId, collection).run();
  }
  ready.set(appId, key);
}
