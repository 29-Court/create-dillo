import { type BindValue } from "./environment.js";
import { type ArmadilloEnv } from "./environment.js";
import { type NormalizedTable } from "../index.js";
import { FIELD } from "./http.js";
import { RESERVED_FIELDS } from "./http.js";
import { HttpError } from "./http.js";
import { sqlIdentifier } from "./records.js";
import { type JsonPrimitive } from "../backend.js";
import { type NormalizedField } from "../index.js";
import { physicalValue } from "./records.js";
import { type QueryFilter } from "./environment.js";
import { isObject } from "./helpers/json.js";
import { type QueryOrder } from "./environment.js";
import { type NearConstraint } from "./environment.js";
import { boundingBox, distanceInMeters, physicalGeoColumns } from "../index.js";
import { type BoundingBoxConstraint } from "./environment.js";
import { type SpatialOrder } from "./environment.js";
import { type JsonObject } from "../backend.js";
import { haversineDistance } from "../index.js";
import { type SchemaDefinition } from "../index.js";
import { INTERNAL_TABLES } from "../backend.js";
import { recordAccessClause } from "./permissions.js";
import { physicalTableName } from "../index.js";
import { physicalFields } from "./records.js";
import { type InternalObjectRow } from "../backend.js";
import { type PhysicalObjectRow } from "./records.js";
import { physicalObjectJson } from "./records.js";
import { objectJson, publicProfileFields } from "./records.js";
import { computedObjectJson } from "./records.js";
import { findObject } from "./records.js";
import { validName } from "./apps.js";
import { optionalAuth, requireAuth } from "./auth.js";
import { readJson } from "./validation.js";
import { json } from "./http.js";

export function queryField(
  field: string,
  parameters: BindValue[],
  env: ArmadilloEnv,
  table?: NormalizedTable,
): string {
  const system: Record<string, string> = {
    id: "id",
    ownerId: "owner_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  };
  if (system[field]) return system[field];
  if (field.includes(".")) {
    const parts = field.split(".");
    const [root, ...path] = parts;
    if (!root || table?.fields[root]?.type !== "json"
      || path.length === 0 || path.length > 4 || field.length > 160
      || path.some((part) => !FIELD.test(part))) {
      throw new HttpError(400, "BAD_REQUEST", `JSON query path \`${field}\` is invalid.`);
    }
    if (env.ARMADILLO_SQL_DIALECT === "postgres") {
      throw new HttpError(400, "BAD_REQUEST", "JSON path queries require SQLite or D1 storage.");
    }
    parameters.push(`$.${(table.storage === "columns" ? path : parts).join(".")}`);
    return `json_extract(${table.storage === "columns" ? sqlIdentifier(root) : "data"}, ?)`;
  }
  if (!FIELD.test(field) || RESERVED_FIELDS.has(field)) {
    throw new HttpError(400, "BAD_REQUEST", `Query field \`${field}\` is invalid.`);
  }
  if (table?.fields[field]?.type === "json") {
    throw new HttpError(400, "BAD_REQUEST", `JSON field \`${field}\` is stored with the record and cannot be queried.`);
  }
  if (table?.storage === "columns") {
    if (!table.fields[field]) {
      throw new HttpError(400, "BAD_REQUEST", `Query field \`${field}\` is not declared in the schema.`);
    }
    if (table.fields[field]?.type === "geo") {
      throw new HttpError(400, "BAD_REQUEST", "Geo fields use near(), withinBoundingBox(), or spatial order.");
    }
    return sqlIdentifier(field);
  }
  if (table?.team?.field === field) return "group_id";
  parameters.push(`$.${field}`);
  const extracted = "json_extract(data, ?)";
  if (env.ARMADILLO_SQL_DIALECT !== "postgres") return extracted;
  const declared = table?.fields[field];
  if (declared?.type === "integer") return `CAST(${extracted} AS BIGINT)`;
  if (declared?.type === "number") return `CAST(${extracted} AS DOUBLE PRECISION)`;
  if (declared?.type === "boolean") return `CAST(${extracted} AS BOOLEAN)`;
  return extracted;
}

export function queryValue(
  value: JsonPrimitive,
  field: NormalizedField | undefined,
  env: ArmadilloEnv,
): BindValue | boolean {
  if (field) return physicalValue(value, field, env);
  if (env.ARMADILLO_SQL_DIALECT === "postgres" && typeof value !== "string" && value !== null) {
    // Schema-free JSON has no declared SQL type. PostgreSQL's text extraction
    // still gives exact equality while a serious typed schema gets numeric and
    // boolean casts through the branch above.
    return String(value);
  }
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

export function parseFilters(value: unknown): QueryFilter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new HttpError(400, "BAD_REQUEST", "filters must be an array of at most 20 entries.");
  }
  return value.map((item) => {
    if (!isObject(item) || typeof item.field !== "string" || typeof item.operator !== "string" || !("value" in item)) {
      throw new HttpError(400, "BAD_REQUEST", "A query filter is invalid.");
    }
    if (!["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"].includes(item.operator)) {
      throw new HttpError(400, "BAD_REQUEST", "A query operator is invalid.");
    }
    return item as unknown as QueryFilter;
  });
}

export function parseOrder(value: unknown): QueryOrder[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new HttpError(400, "BAD_REQUEST", "order must be an array of at most 3 entries.");
  }
  return value.map((item) => {
    if (
      !isObject(item) ||
      typeof item.field !== "string" ||
      (item.direction !== "asc" && item.direction !== "desc")
    ) {
      throw new HttpError(400, "BAD_REQUEST", "A query ordering is invalid.");
    }
    return item as unknown as QueryOrder;
  });
}

export function geoPoint(value: unknown, label: string): NearConstraint["center"] {
  if (!isObject(value)
    || typeof value.latitude !== "number" || !Number.isFinite(value.latitude)
    || value.latitude < -90 || value.latitude > 90
    || typeof value.longitude !== "number" || !Number.isFinite(value.longitude)
    || value.longitude < -180 || value.longitude > 180
    || (value.altitude !== undefined && (typeof value.altitude !== "number" || !Number.isFinite(value.altitude)))) {
    throw new HttpError(400, "BAD_REQUEST", `${label} must contain valid latitude and longitude.`);
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    ...(typeof value.altitude === "number" ? { altitude: value.altitude } : {}),
  };
}

export function requireGeoField(table: NormalizedTable | undefined, field: unknown): string {
  if (typeof field !== "string" || table?.fields[field]?.type !== "geo") {
    throw new HttpError(400, "BAD_REQUEST", "Spatial queries require a declared geo field.");
  }
  return field;
}

export function parseNear(value: unknown, table: NormalizedTable | undefined): NearConstraint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new HttpError(400, "BAD_REQUEST", "near must be an array of 1 to 3 spatial constraints.");
  }
  return value.map((entry, index) => {
    if (!isObject(entry)) throw new HttpError(400, "BAD_REQUEST", "A near constraint is invalid.");
    const unit = entry.unit ?? "meters";
    if (unit !== "meters" && unit !== "kilometers" && unit !== "miles") {
      throw new HttpError(400, "BAD_REQUEST", "Spatial distance unit is invalid.");
    }
    const radius = Number(entry.radius);
    try {
      distanceInMeters(radius, unit);
    } catch {
      throw new HttpError(400, "BAD_REQUEST", "Spatial radius must be a non-negative number.");
    }
    return {
      field: requireGeoField(table, entry.field),
      center: geoPoint(entry.center, `near[${index}].center`),
      radius,
      unit,
    };
  });
}

export function parseBoundingBoxes(value: unknown, table: NormalizedTable | undefined): BoundingBoxConstraint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new HttpError(400, "BAD_REQUEST", "boundingBoxes must be an array of 1 to 3 constraints.");
  }
  return value.map((entry, index) => {
    if (!isObject(entry)) throw new HttpError(400, "BAD_REQUEST", "A bounding box is invalid.");
    const northEast = geoPoint(entry.northEast, `boundingBoxes[${index}].northEast`);
    const southWest = geoPoint(entry.southWest, `boundingBoxes[${index}].southWest`);
    if (northEast.latitude < southWest.latitude) {
      throw new HttpError(400, "BAD_REQUEST", "Bounding-box northEast must be north of southWest.");
    }
    return { field: requireGeoField(table, entry.field), northEast, southWest };
  });
}

export function parseSpatialOrder(value: unknown, table: NormalizedTable | undefined): SpatialOrder | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || (value.direction !== "nearest" && value.direction !== "farthest")) {
    throw new HttpError(400, "BAD_REQUEST", "spatialOrder is invalid.");
  }
  return {
    field: requireGeoField(table, value.field),
    center: geoPoint(value.center, "spatialOrder.center"),
    direction: value.direction,
  };
}

export const INCLUDE_DEPTH_MESSAGE = "Includes go 3 deep. Need more? Pluck it out and .expand() it.";

const INVERSE_ROW_CAP = 100;
/**
 * Ceiling on the parents one inverse-expand hop may resolve. Guards the
 * multiplicative shape of a nested include, where each level's output becomes the
 * next level's parents.
 */
const INVERSE_PARENT_CAP = 500;
/** Ceiling on the rows one inverse-expand hop may materialise across all chunks. */
const INVERSE_TOTAL_CAP = 2_000;
const EXPAND_SEGMENT_CAP = 8;

export interface ExpandNode {
  field: string;
  expand?: ExpandNode[];
}

/** The only keys an expand entry carries. The loader reads nothing else. */
const EXPAND_ENTRY_KEYS = new Set(["field", "expand"]);
/**
 * Options the client used to type, and the server used to drop on the floor:
 * `expand(field, { limit, orderBy, descending })` returned up to 100 unordered
 * rows per parent and said nothing. They are named in the error because that
 * spelling is the one people are holding.
 */
const UNSUPPORTED_EXPAND_OPTIONS = new Set(["limit", "orderBy", "descending"]);

/**
 * An option that changes the shape of the result has to be honoured or refused.
 * The loader here is capped rather than clever — 100 rows per parent, ordered by
 * id, from chunked statements with a per-statement LIMIT — so per-parent ordering
 * and top-N are not something it can add without reopening the fan-out that
 * `INVERSE_PARENT_CAP` and `INVERSE_TOTAL_CAP` bound. Refuse, and say where to
 * go instead: query that table on its own, where limit and order already work.
 */
function assertExpandEntryKeys(entry: object): void {
  for (const key of Object.keys(entry)) {
    if (EXPAND_ENTRY_KEYS.has(key)) continue;
    throw new HttpError(
      400,
      "BAD_REQUEST",
      UNSUPPORTED_EXPAND_OPTIONS.has(key)
        ? `Expand option \`${key}\` is not supported. An include takes no options: it returns up to 100 rows per parent, ordered by id. Query that table on its own for a limit or an order.`
        : `Expand entry key \`${key}\` is not supported. An expand entry takes \`field\` and \`expand\` only.`,
    );
  }
}

type IncludeHop =
  | { direction: "forward"; field: string; target: string }
  | { direction: "inverse"; field: string; table: string; pointer: string };

function assertExpandShape(value: unknown, depth: number): void {
  if (depth > 3) throw new HttpError(400, "BAD_REQUEST", INCLUDE_DEPTH_MESSAGE);
  if (!Array.isArray(value)) throw new HttpError(400, "BAD_REQUEST", "expands must be an array.");
  if (value.length > 10) {
    throw new HttpError(400, "BAD_REQUEST", "expands must contain at most 10 relations.");
  }
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.field !== "string" || entry.field.length === 0) {
      throw new HttpError(400, "BAD_REQUEST", "An expand entry is invalid.");
    }
    assertExpandEntryKeys(entry);
    if (entry.expand === undefined) continue;
    if (!Array.isArray(entry.expand)) {
      throw new HttpError(400, "BAD_REQUEST", "Nested expands must be an array of field names or relations.");
    }
    if (entry.expand.length > 10) {
      throw new HttpError(400, "BAD_REQUEST", "expands must contain at most 10 relations.");
    }
    const nestedObjects: Record<string, unknown>[] = [];
    for (const item of entry.expand) {
      if (typeof item === "string") {
        if (item.length === 0) throw new HttpError(400, "BAD_REQUEST", "An expand entry is invalid.");
        if (depth + 1 > 3) throw new HttpError(400, "BAD_REQUEST", INCLUDE_DEPTH_MESSAGE);
        continue;
      }
      if (isObject(item)) {
        nestedObjects.push(item);
        continue;
      }
      throw new HttpError(400, "BAD_REQUEST", "An expand entry is invalid.");
    }
    if (nestedObjects.length > 0) assertExpandShape(nestedObjects, depth + 1);
  }
}

function backPointers(definition: SchemaDefinition, childTable: string, parentCollection: string): string[] {
  const child = definition.normalized.tables[childTable];
  if (!child) return [];
  const names: string[] = [];
  for (const [name, field] of Object.entries(child.fields)) {
    if (field.type === "pointer" && field.target === parentCollection) names.push(name);
  }
  names.sort();
  return names;
}

function resolveIncludeHop(
  definition: SchemaDefinition | undefined,
  collection: string,
  table: NormalizedTable | undefined,
  key: string,
): IncludeHop {
  const direct = table?.fields[key];
  if (direct?.type === "pointer" && direct.target) {
    return { direction: "forward", field: key, target: direct.target };
  }
  const dot = key.indexOf(".");
  if (dot > 0) {
    const tableName = key.slice(0, dot);
    const pointer = key.slice(dot + 1);
    const child = definition?.normalized.tables[tableName];
    const field = child?.fields[pointer];
    if (!definition || !FIELD.test(tableName) || !FIELD.test(pointer)
      || field?.type !== "pointer" || field.target !== collection) {
      throw new HttpError(400, "BAD_REQUEST", `Expand field \`${key}\` is not a declared relation.`);
    }
    return { direction: "inverse", field: key, table: tableName, pointer };
  }
  if (!definition || !FIELD.test(key) || !definition.normalized.tables[key]) {
    throw new HttpError(400, "BAD_REQUEST", `Expand field \`${key}\` is not a declared relation.`);
  }
  const matches = backPointers(definition, key, collection);
  if (matches.length > 1) {
    const listed = matches.map((name) => `\`${name}\``).join(" and ");
    const example = matches[0] ?? "field";
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `Include \`${key}\` matches more than one pointer back to this table: ${listed}. Name the field, for example \`${key}.${example}\`.`,
    );
  }
  const only = matches[0];
  if (only) return { direction: "inverse", field: key, table: key, pointer: only };
  throw new HttpError(400, "BAD_REQUEST", `Expand field \`${key}\` is not a declared relation.`);
}

function hopTable(definition: SchemaDefinition | undefined, hop: IncludeHop): NormalizedTable | undefined {
  if (hop.direction === "inverse") return definition?.normalized.tables[hop.table];
  if (hop.target === "_User" || hop.target === "_Team") return undefined;
  return definition?.normalized.tables[hop.target];
}

function hopCollection(hop: IncludeHop): string {
  return hop.direction === "forward" ? hop.target : hop.table;
}

function buildExpandList(
  value: readonly unknown[],
  definition: SchemaDefinition | undefined,
  collection: string,
  table: NormalizedTable | undefined,
): ExpandNode[] {
  return value.map((entry) => {
    if (typeof entry === "string") {
      resolveIncludeHop(definition, collection, table, entry);
      return { field: entry };
    }
    const record = entry as Record<string, unknown>;
    const field = record.field as string;
    const hop = resolveIncludeHop(definition, collection, table, field);
    const childCollection = hopCollection(hop);
    const childTable = hopTable(definition, hop);
    const rawNested = Array.isArray(record.expand) ? record.expand : [];
    if (rawNested.length === 0) return { field };
    // System rows expose id and name only. Nested names stay on the wire and are not applied.
    if (childCollection === "_User" || childCollection === "_Team") {
      const expand = rawNested.map((item) => typeof item === "string"
        ? { field: item }
        : { field: (item as { field: string }).field });
      return { field, expand };
    }
    return {
      field,
      expand: buildExpandList(rawNested, definition, childCollection, childTable),
    };
  });
}

export function parseExpands(
  value: unknown,
  table: NormalizedTable | undefined,
  depth = 1,
  definition?: SchemaDefinition,
  collection?: string,
): ExpandNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "BAD_REQUEST", "expands must be an array.");
  assertExpandShape(value, depth);
  return buildExpandList(value, definition, collection ?? "", table);
}

export function recordPoint(record: JsonObject, field: string): NearConstraint["center"] | undefined {
  const value = record[field];
  if (!isObject(value) || typeof value.latitude !== "number" || typeof value.longitude !== "number") return undefined;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    ...(typeof value.altitude === "number" ? { altitude: value.altitude } : {}),
  };
}

/** Max in-area candidates a spatial query will load before asking the caller to narrow. */
export const SPATIAL_CANDIDATE_LIMIT = 10_000;

function geoCoordinateExpressions(
  field: string,
  table: NormalizedTable | undefined,
  env: ArmadilloEnv,
): { latitude: string; longitude: string } {
  if (table?.storage === "columns") {
    const [latitude, longitude] = physicalGeoColumns(field);
    return { latitude: sqlIdentifier(latitude), longitude: sqlIdentifier(longitude) };
  }
  if (env.ARMADILLO_SQL_DIALECT === "postgres") {
    return {
      latitude: `CAST(CAST(data AS jsonb) #>> '{${field},latitude}' AS DOUBLE PRECISION)`,
      longitude: `CAST(CAST(data AS jsonb) #>> '{${field},longitude}' AS DOUBLE PRECISION)`,
    };
  }
  return {
    latitude: `CAST(json_extract(data, '$.${field}.latitude') AS REAL)`,
    longitude: `CAST(json_extract(data, '$.${field}.longitude') AS REAL)`,
  };
}

function pushBoundingBoxClause(
  clauses: string[],
  parameters: BindValue[],
  field: string,
  northEast: NearConstraint["center"],
  southWest: NearConstraint["center"],
  table: NormalizedTable | undefined,
  env: ArmadilloEnv,
): void {
  const { latitude, longitude } = geoCoordinateExpressions(field, table, env);
  clauses.push(`${latitude} >= ?`);
  parameters.push(southWest.latitude);
  clauses.push(`${latitude} <= ?`);
  parameters.push(northEast.latitude);
  if (southWest.longitude <= northEast.longitude) {
    clauses.push(`${longitude} >= ?`);
    parameters.push(southWest.longitude);
    clauses.push(`${longitude} <= ?`);
    parameters.push(northEast.longitude);
  } else {
    // Antimeridian wrap: west of NE or east of SW.
    clauses.push(`(${longitude} >= ? OR ${longitude} <= ?)`);
    parameters.push(southWest.longitude, northEast.longitude);
  }
}

/** Bound spatial candidates by near/bbox areas. Returns false when only nearest-order (no area). */
export function pushSpatialAreaClauses(
  clauses: string[],
  parameters: BindValue[],
  near: NearConstraint[],
  boundingBoxes: BoundingBoxConstraint[],
  table: NormalizedTable | undefined,
  env: ArmadilloEnv,
): boolean {
  let bounded = false;
  for (const constraint of near) {
    const box = boundingBox(constraint.center, distanceInMeters(constraint.radius, constraint.unit));
    pushBoundingBoxClause(clauses, parameters, constraint.field, box.northEast, box.southWest, table, env);
    bounded = true;
  }
  for (const bounds of boundingBoxes) {
    pushBoundingBoxClause(clauses, parameters, bounds.field, bounds.northEast, bounds.southWest, table, env);
    bounded = true;
  }
  return bounded;
}

export function applySpatialQuery(
  records: JsonObject[],
  near: NearConstraint[],
  boundingBoxes: BoundingBoxConstraint[],
  spatialOrder: SpatialOrder | undefined,
  includeDistance: string | undefined,
): JsonObject[] {
  let result = records.filter((record) => near.every((constraint) => {
    const point = recordPoint(record, constraint.field);
    return point !== undefined
      && haversineDistance(point, constraint.center) <= distanceInMeters(constraint.radius, constraint.unit);
  })).filter((record) => boundingBoxes.every((bounds) => {
    const point = recordPoint(record, bounds.field);
    if (!point) return false;
    const longitudeMatches = bounds.southWest.longitude <= bounds.northEast.longitude
      ? point.longitude >= bounds.southWest.longitude && point.longitude <= bounds.northEast.longitude
      : point.longitude >= bounds.southWest.longitude || point.longitude <= bounds.northEast.longitude;
    return point.latitude >= bounds.southWest.latitude
      && point.latitude <= bounds.northEast.latitude
      && longitudeMatches;
  }));
  if (spatialOrder) {
    result = [...result].sort((left, right) => {
      const leftPoint = recordPoint(left, spatialOrder.field);
      const rightPoint = recordPoint(right, spatialOrder.field);
      const leftDistance = leftPoint ? haversineDistance(leftPoint, spatialOrder.center) : Number.POSITIVE_INFINITY;
      const rightDistance = rightPoint ? haversineDistance(rightPoint, spatialOrder.center) : Number.POSITIVE_INFINITY;
      return spatialOrder.direction === "nearest"
        ? leftDistance - rightDistance
        : rightDistance - leftDistance;
    });
  }
  if (includeDistance) {
    const source = spatialOrder?.field === includeDistance
      ? spatialOrder.center
      : near.find((constraint) => constraint.field === includeDistance)?.center;
    if (!source) {
      throw new HttpError(400, "BAD_REQUEST", "includeDistance must reference a near or spatial-order field.");
    }
    result = result.map((record) => {
      const point = recordPoint(record, includeDistance);
      return { ...record, _distance: point ? haversineDistance(point, source) : null };
    });
  }
  return result;
}

export async function expandedRecordMap(
  env: ArmadilloEnv,
  currentAppId: string,
  target: string,
  ids: readonly string[],
  definition: SchemaDefinition,
  requesterId: string | undefined,
): Promise<Map<string, JsonObject>> {
  const unique = [...new Set(ids)].slice(0, 1_000);
  if (unique.length === 0) return new Map();
  // D1 permits 100 bound values per statement, including policy parameters.
  // Keep the same permission predicate for every chunk.
  if (unique.length > 80) {
    const records = new Map<string, JsonObject>();
    for (let offset = 0; offset < unique.length; offset += 80) {
      for (const [id, record] of await expandedRecordMap(env, currentAppId, target, unique.slice(offset, offset + 80), definition, requesterId)) {
        records.set(id, record);
      }
    }
    return records;
  }
  if (target === "_User") {
    if (!requesterId) return new Map();
    // P1 fix (2026-10-05): _User expands are visibility-checked like the _Team
    // branch below — the requester sees themselves plus users who share at
    // least one team with them. The old guard (authenticated-only) disclosed
    // every declared profile field of any user to any authenticated caller.
    const userPlaceholders = unique.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT u.id, u.name, u.profile FROM ${INTERNAL_TABLES.users} AS u
        WHERE u.app_id = ? AND u.id IN (${userPlaceholders})
          AND (u.id = ? OR EXISTS (
            SELECT 1 FROM ${INTERNAL_TABLES.groupMembers} AS m1
            JOIN ${INTERNAL_TABLES.groupMembers} AS m2
              ON m2.app_id = m1.app_id AND m2.group_id = m1.group_id
            WHERE m1.app_id = u.app_id AND m1.user_id = ? AND m2.user_id = u.id
          ))`,
    ).bind(currentAppId, ...unique, requesterId, requesterId).all<{ id: string; name: string | null; profile: string | null }>();
    const profileFields = definition.normalized.users?.fields;
    return new Map((rows.results ?? []).map((row) => [row.id, {
      id: row.id,
      name: row.name,
      ...publicProfileFields(row.profile, profileFields),
    }]));
  }
  if (target === "_Team") {
    if (!requesterId) return new Map();
    const rows = await env.DB.prepare(
      `SELECT g.id, g.name, g.slug
         FROM ${INTERNAL_TABLES.groups} AS g
         JOIN ${INTERNAL_TABLES.groupMembers} AS m
           ON m.app_id = g.app_id AND m.group_id = g.id
        WHERE g.app_id = ? AND m.user_id = ? AND g.id IN (${unique.map(() => "?").join(", ")})`,
    ).bind(currentAppId, requesterId, ...unique).all<{ id: string; name: string; slug: string }>();
    return new Map((rows.results ?? []).map((row) => [row.id, { id: row.id, name: row.name, slug: row.slug }]));
  }
  const table = definition.normalized.tables[target];
  if (!table || (table.read !== "public" && !requesterId)) return new Map();
  const parameters: BindValue[] = table.storage === "columns"
    ? [currentAppId]
    : [currentAppId, target];
  const clauses = table.storage === "columns" ? ["app_id = ?"] : ["app_id = ?", "collection = ?"];
  const access = recordAccessClause(table, currentAppId, requesterId, parameters, false);
  if (access) clauses.push(access);
  clauses.push(`id IN (${unique.map(() => "?").join(", ")})`);
  parameters.push(...unique);
  const source = table.storage === "columns"
    ? sqlIdentifier(physicalTableName(currentAppId, target))
    : INTERNAL_TABLES.objects;
  const selected = table.storage === "columns"
    ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, `
    : "data, ";
  const rows = await env.DB.prepare(
    `SELECT id, owner_id, ${selected}created_at, updated_at FROM ${source}
      WHERE ${clauses.join(" AND ")}`,
  ).bind(...parameters).all<InternalObjectRow | PhysicalObjectRow>();
  return new Map((rows.results ?? []).map((row) => {
    const record = table.storage === "columns"
      ? physicalObjectJson(row as PhysicalObjectRow, table)
      : objectJson(row as InternalObjectRow);
    return [record.id as string, computedObjectJson(definition, target, record)];
  }));
}

function recordFromRow(
  row: InternalObjectRow | PhysicalObjectRow,
  table: NormalizedTable,
  definition: SchemaDefinition,
  collection: string,
): JsonObject {
  const record = table.storage === "columns"
    ? physicalObjectJson(row as PhysicalObjectRow, table)
    : objectJson(row as InternalObjectRow);
  return computedObjectJson(definition, collection, record);
}

function pointerSql(env: ArmadilloEnv, table: NormalizedTable, pointer: string): string {
  if (table.storage === "columns") return sqlIdentifier(pointer);
  if (!FIELD.test(pointer)) {
    throw new HttpError(400, "BAD_REQUEST", `Expand field \`${pointer}\` is not a declared relation.`);
  }
  if (env.ARMADILLO_SQL_DIALECT === "postgres") return `data->>'${pointer}'`;
  return `json_extract(data, '$.${pointer}')`;
}

async function inverseRows(
  env: ArmadilloEnv,
  currentAppId: string,
  collection: string,
  pointer: string,
  parentIds: readonly string[],
  definition: SchemaDefinition,
  requesterId: string | undefined,
  label: string,
): Promise<Map<string, JsonObject[]>> {
  const unique = [...new Set(parentIds)];
  const grouped = new Map<string, JsonObject[]>();
  for (const id of unique) grouped.set(id, []);
  const table = definition.normalized.tables[collection];
  if (unique.length === 0 || !table || (table.read !== "public" && !requesterId)) return grouped;
  // Each chunk is a separate statement whose predicate is a `json_extract`
  // comparison, which no index on this table can serve, so every chunk is a full
  // collection scan. Parents come from the previous level of the expand, which
  // caps at `EXPAND_LIMIT_MAX`; with three levels that is ~1 262 scans and ~10^7
  // materialised rows in a single request. Bound the whole hop instead.
  if (unique.length > INVERSE_PARENT_CAP) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `Include of \`${label}\` reached ${unique.length} parents at one level. Query that table on its own.`,
    );
  }
  let remaining = INVERSE_TOTAL_CAP;
  for (let offset = 0; offset < unique.length && remaining > 0; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const parameters: BindValue[] = table.storage === "columns"
      ? [currentAppId]
      : [currentAppId, collection];
    const clauses = table.storage === "columns" ? ["app_id = ?"] : ["app_id = ?", "collection = ?"];
    const access = recordAccessClause(table, currentAppId, requesterId, parameters, false);
    if (access) clauses.push(access);
    clauses.push(`${pointerSql(env, table, pointer)} IN (${chunk.map(() => "?").join(", ")})`);
    parameters.push(...chunk);
    const source = table.storage === "columns"
      ? sqlIdentifier(physicalTableName(currentAppId, collection))
      : INTERNAL_TABLES.objects;
    const selected = table.storage === "columns"
      ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, `
      : "data, ";
    // `LIMIT remaining` stops the statement itself from materialising an entire
    // collection; the per-parent cap below still rejects a runaway parent.
    const rows = await env.DB.prepare(
      `SELECT id, owner_id, ${selected}created_at, updated_at FROM ${source}
        WHERE ${clauses.join(" AND ")} LIMIT ?`,
    ).bind(...parameters, remaining).all<InternalObjectRow | PhysicalObjectRow>();
    for (const row of rows.results ?? []) {
      const record = recordFromRow(row, table, definition, collection);
      const parentId = record[pointer];
      if (typeof parentId !== "string") continue;
      const list = grouped.get(parentId);
      if (!list) continue;
      list.push(record);
      if (list.length > INVERSE_ROW_CAP) {
        throw new HttpError(
          400,
          "BAD_REQUEST",
          `Include of \`${label}\` has more than 100 rows for one parent. Includes are unfiltered. Query that table on its own.`,
        );
      }
    }
    remaining -= (rows.results ?? []).length;
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }
  return grouped;
}

export async function expandRecords(
  env: ArmadilloEnv,
  currentAppId: string,
  collection: string,
  records: JsonObject[],
  expands: ExpandNode[],
  definition: SchemaDefinition,
  requesterId: string | undefined,
  depth = 1,
): Promise<JsonObject[]> {
  let result = records.map((record) => ({ ...record }));
  const table = definition.normalized.tables[collection];
  for (const expand of expands) {
    const hop = resolveIncludeHop(definition, collection, table, expand.field);
    const nested = expand.expand ?? [];
    if (hop.direction === "forward") {
      const ids = result.map((record) => record[hop.field]).filter((value): value is string => typeof value === "string");
      const related = await expandedRecordMap(env, currentAppId, hop.target, ids, definition, requesterId);
      if (nested.length > 0 && hop.target !== "_User" && hop.target !== "_Team") {
        if (depth >= 3) throw new HttpError(400, "BAD_REQUEST", INCLUDE_DEPTH_MESSAGE);
        const expanded = await expandRecords(
          env,
          currentAppId,
          hop.target,
          [...related.values()],
          nested,
          definition,
          requesterId,
          depth + 1,
        );
        related.clear();
        for (const record of expanded) related.set(record.id as string, record);
      }
      result = result.map((record) => ({
        ...record,
        [expand.field]: typeof record[expand.field] === "string"
          ? related.get(record[expand.field] as string) ?? null
          : null,
      }));
      continue;
    }
    const parentIds = result.map((record) => record.id).filter((value): value is string => typeof value === "string");
    const grouped = await inverseRows(
      env,
      currentAppId,
      hop.table,
      hop.pointer,
      parentIds,
      definition,
      requesterId,
      hop.field,
    );
    if (nested.length > 0) {
      if (depth >= 3) throw new HttpError(400, "BAD_REQUEST", INCLUDE_DEPTH_MESSAGE);
      const flat: JsonObject[] = [];
      const owners: string[] = [];
      for (const [parentId, rows] of grouped) {
        for (const row of rows) {
          owners.push(parentId);
          flat.push(row);
        }
      }
      if (flat.length > 0) {
        const expanded = await expandRecords(
          env,
          currentAppId,
          hop.table,
          flat,
          nested,
          definition,
          requesterId,
          depth + 1,
        );
        for (const id of grouped.keys()) grouped.set(id, []);
        expanded.forEach((record, index) => {
          const owner = owners[index];
          if (owner) grouped.get(owner)?.push(record);
        });
        for (const rows of grouped.values()) {
          rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
        }
      }
    }
    result = result.map((record) => ({
      ...record,
      [expand.field]: typeof record.id === "string" ? grouped.get(record.id) ?? [] : [],
    }));
  }
  return result;
}

export async function expandRoute(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
  collection: string,
  id: string,
  definition: SchemaDefinition | undefined,
): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const table = definition?.normalized.tables[collection];
  const publicRead = table?.read === "public";
  const auth = publicRead
    ? await optionalAuth(request, env, currentAppId, "tables:read")
    : await requireAuth(request, env, currentAppId, "tables:read");
  const body = await readJson(request, env);
  if (typeof body.path !== "string" || body.path.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "expand path is invalid.");
  }
  const segments = body.path.split(".");
  if (segments.length > EXPAND_SEGMENT_CAP) {
    throw new HttpError(400, "BAD_REQUEST", "expand() accepts at most 8 segments.");
  }
  if (segments.some((segment) => !FIELD.test(segment))) {
    throw new HttpError(400, "BAD_REQUEST", "expand path is invalid.");
  }
  if (!definition) throw new HttpError(400, "BAD_REQUEST", "expand path is invalid.");
  const row = await findObject(env, currentAppId, collection, id, definition, auth?.user.id, false);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Record not found.");
  let current = computedObjectJson(definition, collection, objectJson(row));
  let currentCollection = collection;
  const seen = new Set<string>([typeof current.id === "string" ? current.id : id]);
  for (const segment of segments) {
    const currentTable = definition.normalized.tables[currentCollection];
    const field = currentTable?.fields[segment];
    if (field?.type !== "pointer" || !field.target) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "expand() follows a ref on this record. Use include() for the records that point here.",
      );
    }
    const nextId = current[segment];
    if (typeof nextId !== "string") return json({ value: null });
    if (seen.has(nextId)) return json({ value: nextId });
    seen.add(nextId);
    const related = await expandedRecordMap(env, currentAppId, field.target, [nextId], definition, auth?.user.id);
    const next = related.get(nextId);
    if (!next) return json({ value: null });
    current = next;
    currentCollection = field.target;
  }
  return json({ value: current, collection: currentCollection });
}

export function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new HttpError(400, "BAD_REQUEST", `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return result as number;
}

export async function queryRoute(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
  collection: string,
  definition: SchemaDefinition | undefined,
): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const publicRead = definition?.normalized.tables[collection]?.read === "public";
  const table = definition?.normalized.tables[collection];
  const auth = publicRead
    ? await optionalAuth(request, env, currentAppId, "tables:read")
    : await requireAuth(request, env, currentAppId, "tables:read");
  const body = await readJson(request, env);
  const filters = parseFilters(body.filters);
  const ordering = parseOrder(body.order);
  const expands = parseExpands(body.expands, table, 1, definition, collection);
  const near = parseNear(body.near, table);
  const boundingBoxes = parseBoundingBoxes(body.boundingBoxes, table);
  const spatialOrder = parseSpatialOrder(body.spatialOrder, table);
  const includeDistance = body.includeDistance === undefined
    ? undefined
    : requireGeoField(table, body.includeDistance);
  const spatial = near.length > 0 || boundingBoxes.length > 0 || spatialOrder !== undefined;
  const parameters: BindValue[] = table?.storage === "columns"
    ? [currentAppId]
    : [currentAppId, collection];
  const clauses = table?.storage === "columns"
    ? ["app_id = ?"]
    : ["app_id = ?", "collection = ?"];
  if (auth) {
    // Public reads carry no predicate; pushing the empty clause would break the WHERE list.
    const access = recordAccessClause(table, currentAppId, auth.user.id, parameters, false);
    if (access) clauses.push(access);
  }

  for (const filter of filters) {
    const expression = queryField(filter.field, parameters, env, table);
    if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
        throw new HttpError(400, "BAD_REQUEST", "containedIn requires 1 to 100 primitive values.");
      }
      if (filter.value.some((item) => item !== null && typeof item === "object")) {
        throw new HttpError(400, "BAD_REQUEST", "containedIn accepts primitive values only.");
      }
      const declaredField = table?.fields[filter.field];
      const values = (filter.value as JsonPrimitive[]).map(value => queryValue(value, declaredField, env) as BindValue);
      if (env.ARMADILLO_SQL_DIALECT === "postgres") {
        clauses.push(`${expression} IN (${values.map(() => "?").join(", ")})`);
        parameters.push(...values);
      } else {
        clauses.push(`${expression} IN (SELECT value FROM json_each(?))`);
        parameters.push(JSON.stringify(values));
      }
      continue;
    }
    if (filter.operator === "contains") {
      if (typeof filter.value !== "string") {
        throw new HttpError(400, "BAD_REQUEST", "contains requires a string.");
      }
      const escaped = filter.value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      clauses.push(`CAST(${expression} AS TEXT) LIKE ? ESCAPE '\\'`);
      parameters.push(`%${escaped}%`);
      continue;
    }
    if (filter.value !== null && typeof filter.value === "object") {
      throw new HttpError(400, "BAD_REQUEST", "Query comparisons accept primitive values only.");
    }
    if (filter.value === null && (filter.operator === "eq" || filter.operator === "ne")) {
      clauses.push(`${expression} IS ${filter.operator === "ne" ? "NOT " : ""}NULL`);
      continue;
    }
    const operators = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
    const operator = operators[filter.operator as keyof typeof operators];
    if (!operator) throw new HttpError(400, "BAD_REQUEST", "Query operator is invalid.");
    clauses.push(`${expression} ${operator} ?`);
    const declaredField = table?.fields[filter.field];
    parameters.push(queryValue(filter.value as JsonPrimitive, declaredField, env) as BindValue);
  }

  const sourceTable = table?.storage === "columns"
    ? sqlIdentifier(physicalTableName(currentAppId, collection))
    : INTERNAL_TABLES.objects;
  if (body.count === true && !spatial) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${sourceTable} WHERE ${clauses.join(" AND ")}`,
    ).bind(...parameters).first<{ count: number }>();
    return json({ count: row?.count ?? 0 });
  }

  const limit = integer(body.limit, 100, 1, 1_000, "limit");
  const skip = integer(body.skip, 0, 0, 10_000, "skip");
  // near/bbox push lat/lng predicates. Nearest-only scans under access alone and
  // 400s when more than SPATIAL_CANDIDATE_LIMIT rows match.
  const areaBounded = spatial
    ? pushSpatialAreaClauses(clauses, parameters, near, boundingBoxes, table, env)
    : false;
  // A bare `spatialOrder` with no radius or bounding box has to rank the entire
  // collection, which this query does by materialising every matching row and
  // sorting in memory. Reject it here rather than after fetching 10 001 full
  // records — on a `read: "public"` table that request is unauthenticated.
  if (spatial && !areaBounded) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Nearest-order scan matches too many points. Narrow the search with near() or withinBoundingBox().",
    );
  }
  const selectedFields = table?.storage === "columns"
    ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, `
    : "data, ";
  const fetchLimit = spatial ? SPATIAL_CANDIDATE_LIMIT + 1 : limit;
  const fetchOffset = spatial ? 0 : skip;
  // Spatial candidate order is irrelevant; exact near/bbox/nearest run in memory.
  // Avoid queryField binds that would not appear in the spatial SELECT.
  // Always end on `id`. `created_at` has millisecond resolution and `createMany`
  // stamps every row in a batch with the same value, so ties are common; without
  // a unique tiebreaker SQLite may order two pages of the same collection
  // differently, and offset paging then skips and duplicates rows.
  const lastDirection = ordering.at(-1)?.direction === "asc" ? "ASC" : "DESC";
  const fetchOrder = spatial
    ? "id ASC"
    : `${ordering.length > 0
      ? ordering.map((item) => `${queryField(item.field, parameters, env, table)} ${item.direction.toUpperCase()}`).join(", ") + ", "
      : "created_at DESC, "}id ${lastDirection}`;
  parameters.push(fetchLimit, fetchOffset);
  const result = await env.DB.prepare(
    `SELECT id, owner_id, ${selectedFields}created_at, updated_at
       FROM ${sourceTable}
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${fetchOrder}
      LIMIT ? OFFSET ?`,
  ).bind(...parameters).all<InternalObjectRow | PhysicalObjectRow>();
  let records = (result.results ?? []).map((row) => {
    const record = table?.storage === "columns"
      ? physicalObjectJson(row as PhysicalObjectRow, table)
      : objectJson(row as InternalObjectRow);
    return computedObjectJson(definition, collection, record);
  });
  if (spatial && records.length > SPATIAL_CANDIDATE_LIMIT) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Spatial search matches too many points. Narrow the search with a smaller radius or bounding box.",
    );
  }
  if (spatial || includeDistance) {
    records = applySpatialQuery(records, near, boundingBoxes, spatialOrder, includeDistance);
  }
  if (body.count === true) return json({ count: records.length });
  if (spatial) records = records.slice(skip, skip + limit);
  if (expands.length > 0 && definition) {
    records = await expandRecords(
      env,
      currentAppId,
      collection,
      records,
      expands,
      definition,
      auth?.user.id,
    );
  }
  return json({ results: records });
}
