import {} from "./environment.js";
import {} from "./environment.js";
import {} from "../index.js";
import { FIELD } from "./http.js";
import { RESERVED_FIELDS } from "./http.js";
import { HttpError } from "./http.js";
import { sqlIdentifier } from "./records.js";
import {} from "../backend.js";
import {} from "../index.js";
import { physicalValue } from "./records.js";
import {} from "./environment.js";
import { isObject } from "./helpers/json.js";
import {} from "./environment.js";
import {} from "./environment.js";
import { boundingBox, distanceInMeters, physicalGeoColumns } from "../index.js";
import {} from "./environment.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { haversineDistance } from "../index.js";
import {} from "../index.js";
import { INTERNAL_TABLES } from "../backend.js";
import { recordAccessClause } from "./permissions.js";
import { physicalTableName } from "../index.js";
import { physicalFields } from "./records.js";
import {} from "../backend.js";
import {} from "./records.js";
import { physicalObjectJson } from "./records.js";
import { objectJson, publicProfileFields } from "./records.js";
import { computedObjectJson } from "./records.js";
import { findObject } from "./records.js";
import { validName } from "./apps.js";
import { optionalAuth, requireAuth } from "./auth.js";
import { readJson } from "./validation.js";
import { json } from "./http.js";
function queryField(field, parameters, env, table) {
  const system = {
    id: "id",
    ownerId: "owner_id",
    createdAt: "created_at",
    updatedAt: "updated_at"
  };
  if (system[field]) return system[field];
  if (field.includes(".")) {
    const parts = field.split(".");
    const [root, ...path] = parts;
    if (!root || table?.fields[root]?.type !== "json" || path.length === 0 || path.length > 4 || field.length > 160 || path.some((part) => !FIELD.test(part))) {
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
function queryValue(value, field, env) {
  if (field) return physicalValue(value, field, env);
  if (env.ARMADILLO_SQL_DIALECT === "postgres" && typeof value !== "string" && value !== null) {
    return String(value);
  }
  return typeof value === "boolean" ? value ? 1 : 0 : value;
}
function parseFilters(value) {
  if (value === void 0) return [];
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
    return item;
  });
}
function parseOrder(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new HttpError(400, "BAD_REQUEST", "order must be an array of at most 3 entries.");
  }
  return value.map((item) => {
    if (!isObject(item) || typeof item.field !== "string" || item.direction !== "asc" && item.direction !== "desc") {
      throw new HttpError(400, "BAD_REQUEST", "A query ordering is invalid.");
    }
    return item;
  });
}
function geoPoint(value, label) {
  if (!isObject(value) || typeof value.latitude !== "number" || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90 || typeof value.longitude !== "number" || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180 || value.altitude !== void 0 && (typeof value.altitude !== "number" || !Number.isFinite(value.altitude))) {
    throw new HttpError(400, "BAD_REQUEST", `${label} must contain valid latitude and longitude.`);
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    ...typeof value.altitude === "number" ? { altitude: value.altitude } : {}
  };
}
function requireGeoField(table, field) {
  if (typeof field !== "string" || table?.fields[field]?.type !== "geo") {
    throw new HttpError(400, "BAD_REQUEST", "Spatial queries require a declared geo field.");
  }
  return field;
}
function parseNear(value, table) {
  if (value === void 0) return [];
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
      unit
    };
  });
}
function parseBoundingBoxes(value, table) {
  if (value === void 0) return [];
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
function parseSpatialOrder(value, table) {
  if (value === void 0) return void 0;
  if (!isObject(value) || value.direction !== "nearest" && value.direction !== "farthest") {
    throw new HttpError(400, "BAD_REQUEST", "spatialOrder is invalid.");
  }
  return {
    field: requireGeoField(table, value.field),
    center: geoPoint(value.center, "spatialOrder.center"),
    direction: value.direction
  };
}
const INCLUDE_DEPTH_MESSAGE = "Includes go 3 deep. Need more? Pluck it out and .expand() it.";
const INVERSE_ROW_CAP = 100;
const INVERSE_PARENT_CAP = 500;
const INVERSE_TOTAL_CAP = 2e3;
const EXPAND_SEGMENT_CAP = 8;
const EXPAND_ENTRY_KEYS = /* @__PURE__ */ new Set(["field", "expand"]);
const UNSUPPORTED_EXPAND_OPTIONS = /* @__PURE__ */ new Set(["limit", "orderBy", "descending"]);
function assertExpandEntryKeys(entry) {
  for (const key of Object.keys(entry)) {
    if (EXPAND_ENTRY_KEYS.has(key)) continue;
    throw new HttpError(
      400,
      "BAD_REQUEST",
      UNSUPPORTED_EXPAND_OPTIONS.has(key) ? `Expand option \`${key}\` is not supported. An include takes no options: it returns up to 100 rows per parent, ordered by id. Query that table on its own for a limit or an order.` : `Expand entry key \`${key}\` is not supported. An expand entry takes \`field\` and \`expand\` only.`
    );
  }
}
function assertExpandShape(value, depth) {
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
    if (entry.expand === void 0) continue;
    if (!Array.isArray(entry.expand)) {
      throw new HttpError(400, "BAD_REQUEST", "Nested expands must be an array of field names or relations.");
    }
    if (entry.expand.length > 10) {
      throw new HttpError(400, "BAD_REQUEST", "expands must contain at most 10 relations.");
    }
    const nestedObjects = [];
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
function backPointers(definition, childTable, parentCollection) {
  const child = definition.normalized.tables[childTable];
  if (!child) return [];
  const names = [];
  for (const [name, field] of Object.entries(child.fields)) {
    if (field.type === "pointer" && field.target === parentCollection) names.push(name);
  }
  names.sort();
  return names;
}
function resolveIncludeHop(definition, collection, table, key) {
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
    if (!definition || !FIELD.test(tableName) || !FIELD.test(pointer) || field?.type !== "pointer" || field.target !== collection) {
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
      `Include \`${key}\` matches more than one pointer back to this table: ${listed}. Name the field, for example \`${key}.${example}\`.`
    );
  }
  const only = matches[0];
  if (only) return { direction: "inverse", field: key, table: key, pointer: only };
  throw new HttpError(400, "BAD_REQUEST", `Expand field \`${key}\` is not a declared relation.`);
}
function hopTable(definition, hop) {
  if (hop.direction === "inverse") return definition?.normalized.tables[hop.table];
  if (hop.target === "_User" || hop.target === "_Team") return void 0;
  return definition?.normalized.tables[hop.target];
}
function hopCollection(hop) {
  return hop.direction === "forward" ? hop.target : hop.table;
}
function buildExpandList(value, definition, collection, table) {
  return value.map((entry) => {
    if (typeof entry === "string") {
      resolveIncludeHop(definition, collection, table, entry);
      return { field: entry };
    }
    const record = entry;
    const field = record.field;
    const hop = resolveIncludeHop(definition, collection, table, field);
    const childCollection = hopCollection(hop);
    const childTable = hopTable(definition, hop);
    const rawNested = Array.isArray(record.expand) ? record.expand : [];
    if (rawNested.length === 0) return { field };
    if (childCollection === "_User" || childCollection === "_Team") {
      const expand = rawNested.map((item) => typeof item === "string" ? { field: item } : { field: item.field });
      return { field, expand };
    }
    return {
      field,
      expand: buildExpandList(rawNested, definition, childCollection, childTable)
    };
  });
}
function parseExpands(value, table, depth = 1, definition, collection) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "BAD_REQUEST", "expands must be an array.");
  assertExpandShape(value, depth);
  return buildExpandList(value, definition, collection ?? "", table);
}
function recordPoint(record, field) {
  const value = record[field];
  if (!isObject(value) || typeof value.latitude !== "number" || typeof value.longitude !== "number") return void 0;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    ...typeof value.altitude === "number" ? { altitude: value.altitude } : {}
  };
}
const SPATIAL_CANDIDATE_LIMIT = 1e4;
function geoCoordinateExpressions(field, table, env) {
  if (table?.storage === "columns") {
    const [latitude, longitude] = physicalGeoColumns(field);
    return { latitude: sqlIdentifier(latitude), longitude: sqlIdentifier(longitude) };
  }
  if (env.ARMADILLO_SQL_DIALECT === "postgres") {
    return {
      latitude: `CAST(CAST(data AS jsonb) #>> '{${field},latitude}' AS DOUBLE PRECISION)`,
      longitude: `CAST(CAST(data AS jsonb) #>> '{${field},longitude}' AS DOUBLE PRECISION)`
    };
  }
  return {
    latitude: `CAST(json_extract(data, '$.${field}.latitude') AS REAL)`,
    longitude: `CAST(json_extract(data, '$.${field}.longitude') AS REAL)`
  };
}
function pushBoundingBoxClause(clauses, parameters, field, northEast, southWest, table, env) {
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
    clauses.push(`(${longitude} >= ? OR ${longitude} <= ?)`);
    parameters.push(southWest.longitude, northEast.longitude);
  }
}
function pushSpatialAreaClauses(clauses, parameters, near, boundingBoxes, table, env) {
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
function applySpatialQuery(records, near, boundingBoxes, spatialOrder, includeDistance) {
  let result = records.filter((record) => near.every((constraint) => {
    const point = recordPoint(record, constraint.field);
    return point !== void 0 && haversineDistance(point, constraint.center) <= distanceInMeters(constraint.radius, constraint.unit);
  })).filter((record) => boundingBoxes.every((bounds) => {
    const point = recordPoint(record, bounds.field);
    if (!point) return false;
    const longitudeMatches = bounds.southWest.longitude <= bounds.northEast.longitude ? point.longitude >= bounds.southWest.longitude && point.longitude <= bounds.northEast.longitude : point.longitude >= bounds.southWest.longitude || point.longitude <= bounds.northEast.longitude;
    return point.latitude >= bounds.southWest.latitude && point.latitude <= bounds.northEast.latitude && longitudeMatches;
  }));
  if (spatialOrder) {
    result = [...result].sort((left, right) => {
      const leftPoint = recordPoint(left, spatialOrder.field);
      const rightPoint = recordPoint(right, spatialOrder.field);
      const leftDistance = leftPoint ? haversineDistance(leftPoint, spatialOrder.center) : Number.POSITIVE_INFINITY;
      const rightDistance = rightPoint ? haversineDistance(rightPoint, spatialOrder.center) : Number.POSITIVE_INFINITY;
      return spatialOrder.direction === "nearest" ? leftDistance - rightDistance : rightDistance - leftDistance;
    });
  }
  if (includeDistance) {
    const source = spatialOrder?.field === includeDistance ? spatialOrder.center : near.find((constraint) => constraint.field === includeDistance)?.center;
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
async function expandedRecordMap(env, currentAppId, target, ids, definition, requesterId) {
  const unique = [...new Set(ids)].slice(0, 1e3);
  if (unique.length === 0) return /* @__PURE__ */ new Map();
  if (unique.length > 80) {
    const records = /* @__PURE__ */ new Map();
    for (let offset = 0; offset < unique.length; offset += 80) {
      for (const [id, record] of await expandedRecordMap(env, currentAppId, target, unique.slice(offset, offset + 80), definition, requesterId)) {
        records.set(id, record);
      }
    }
    return records;
  }
  if (target === "_User") {
    if (!requesterId) return /* @__PURE__ */ new Map();
    const userPlaceholders = unique.map(() => "?").join(", ");
    const rows2 = await env.DB.prepare(
      `SELECT u.id, u.name, u.profile FROM ${INTERNAL_TABLES.users} AS u
        WHERE u.app_id = ? AND u.id IN (${userPlaceholders})
          AND (u.id = ? OR EXISTS (
            SELECT 1 FROM ${INTERNAL_TABLES.groupMembers} AS m1
            JOIN ${INTERNAL_TABLES.groupMembers} AS m2
              ON m2.app_id = m1.app_id AND m2.group_id = m1.group_id
            WHERE m1.app_id = u.app_id AND m1.user_id = ? AND m2.user_id = u.id
          ))`
    ).bind(currentAppId, ...unique, requesterId, requesterId).all();
    const profileFields = definition.normalized.users?.fields;
    return new Map((rows2.results ?? []).map((row) => [row.id, {
      id: row.id,
      name: row.name,
      ...publicProfileFields(row.profile, profileFields)
    }]));
  }
  if (target === "_Team") {
    if (!requesterId) return /* @__PURE__ */ new Map();
    const rows2 = await env.DB.prepare(
      `SELECT g.id, g.name, g.slug
         FROM ${INTERNAL_TABLES.groups} AS g
         JOIN ${INTERNAL_TABLES.groupMembers} AS m
           ON m.app_id = g.app_id AND m.group_id = g.id
        WHERE g.app_id = ? AND m.user_id = ? AND g.id IN (${unique.map(() => "?").join(", ")})`
    ).bind(currentAppId, requesterId, ...unique).all();
    return new Map((rows2.results ?? []).map((row) => [row.id, { id: row.id, name: row.name, slug: row.slug }]));
  }
  const table = definition.normalized.tables[target];
  if (!table || table.read !== "public" && !requesterId) return /* @__PURE__ */ new Map();
  const parameters = table.storage === "columns" ? [currentAppId] : [currentAppId, target];
  const clauses = table.storage === "columns" ? ["app_id = ?"] : ["app_id = ?", "collection = ?"];
  const access = recordAccessClause(table, currentAppId, requesterId, parameters, false);
  if (access) clauses.push(access);
  clauses.push(`id IN (${unique.map(() => "?").join(", ")})`);
  parameters.push(...unique);
  const source = table.storage === "columns" ? sqlIdentifier(physicalTableName(currentAppId, target)) : INTERNAL_TABLES.objects;
  const selected = table.storage === "columns" ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, ` : "data, ";
  const rows = await env.DB.prepare(
    `SELECT id, owner_id, ${selected}created_at, updated_at FROM ${source}
      WHERE ${clauses.join(" AND ")}`
  ).bind(...parameters).all();
  return new Map((rows.results ?? []).map((row) => {
    const record = table.storage === "columns" ? physicalObjectJson(row, table) : objectJson(row);
    return [record.id, computedObjectJson(definition, target, record)];
  }));
}
function recordFromRow(row, table, definition, collection) {
  const record = table.storage === "columns" ? physicalObjectJson(row, table) : objectJson(row);
  return computedObjectJson(definition, collection, record);
}
function pointerSql(env, table, pointer) {
  if (table.storage === "columns") return sqlIdentifier(pointer);
  if (!FIELD.test(pointer)) {
    throw new HttpError(400, "BAD_REQUEST", `Expand field \`${pointer}\` is not a declared relation.`);
  }
  if (env.ARMADILLO_SQL_DIALECT === "postgres") return `data->>'${pointer}'`;
  return `json_extract(data, '$.${pointer}')`;
}
async function inverseRows(env, currentAppId, collection, pointer, parentIds, definition, requesterId, label) {
  const unique = [...new Set(parentIds)];
  const grouped = /* @__PURE__ */ new Map();
  for (const id of unique) grouped.set(id, []);
  const table = definition.normalized.tables[collection];
  if (unique.length === 0 || !table || table.read !== "public" && !requesterId) return grouped;
  if (unique.length > INVERSE_PARENT_CAP) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `Include of \`${label}\` reached ${unique.length} parents at one level. Query that table on its own.`
    );
  }
  let remaining = INVERSE_TOTAL_CAP;
  for (let offset = 0; offset < unique.length && remaining > 0; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const parameters = table.storage === "columns" ? [currentAppId] : [currentAppId, collection];
    const clauses = table.storage === "columns" ? ["app_id = ?"] : ["app_id = ?", "collection = ?"];
    const access = recordAccessClause(table, currentAppId, requesterId, parameters, false);
    if (access) clauses.push(access);
    clauses.push(`${pointerSql(env, table, pointer)} IN (${chunk.map(() => "?").join(", ")})`);
    parameters.push(...chunk);
    const source = table.storage === "columns" ? sqlIdentifier(physicalTableName(currentAppId, collection)) : INTERNAL_TABLES.objects;
    const selected = table.storage === "columns" ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, ` : "data, ";
    const rows = await env.DB.prepare(
      `SELECT id, owner_id, ${selected}created_at, updated_at FROM ${source}
        WHERE ${clauses.join(" AND ")} LIMIT ?`
    ).bind(...parameters, remaining).all();
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
          `Include of \`${label}\` has more than 100 rows for one parent. Includes are unfiltered. Query that table on its own.`
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
async function expandRecords(env, currentAppId, collection, records, expands, definition, requesterId, depth = 1) {
  let result = records.map((record) => ({ ...record }));
  const table = definition.normalized.tables[collection];
  for (const expand of expands) {
    const hop = resolveIncludeHop(definition, collection, table, expand.field);
    const nested = expand.expand ?? [];
    if (hop.direction === "forward") {
      const ids = result.map((record) => record[hop.field]).filter((value) => typeof value === "string");
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
          depth + 1
        );
        related.clear();
        for (const record of expanded) related.set(record.id, record);
      }
      result = result.map((record) => ({
        ...record,
        [expand.field]: typeof record[expand.field] === "string" ? related.get(record[expand.field]) ?? null : null
      }));
      continue;
    }
    const parentIds = result.map((record) => record.id).filter((value) => typeof value === "string");
    const grouped = await inverseRows(
      env,
      currentAppId,
      hop.table,
      hop.pointer,
      parentIds,
      definition,
      requesterId,
      hop.field
    );
    if (nested.length > 0) {
      if (depth >= 3) throw new HttpError(400, "BAD_REQUEST", INCLUDE_DEPTH_MESSAGE);
      const flat = [];
      const owners = [];
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
          depth + 1
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
      [expand.field]: typeof record.id === "string" ? grouped.get(record.id) ?? [] : []
    }));
  }
  return result;
}
async function expandRoute(request, env, currentAppId, collection, id, definition) {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const table = definition?.normalized.tables[collection];
  const publicRead = table?.read === "public";
  const auth = publicRead ? await optionalAuth(request, env, currentAppId, "tables:read") : await requireAuth(request, env, currentAppId, "tables:read");
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
  const seen = /* @__PURE__ */ new Set([typeof current.id === "string" ? current.id : id]);
  for (const segment of segments) {
    const currentTable = definition.normalized.tables[currentCollection];
    const field = currentTable?.fields[segment];
    if (field?.type !== "pointer" || !field.target) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "expand() follows a ref on this record. Use include() for the records that point here."
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
function integer(value, fallback, minimum, maximum, label) {
  const result = value === void 0 ? fallback : value;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new HttpError(400, "BAD_REQUEST", `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}
async function queryRoute(request, env, currentAppId, collection, definition) {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const publicRead = definition?.normalized.tables[collection]?.read === "public";
  const table = definition?.normalized.tables[collection];
  const auth = publicRead ? await optionalAuth(request, env, currentAppId, "tables:read") : await requireAuth(request, env, currentAppId, "tables:read");
  const body = await readJson(request, env);
  const filters = parseFilters(body.filters);
  const ordering = parseOrder(body.order);
  const expands = parseExpands(body.expands, table, 1, definition, collection);
  const near = parseNear(body.near, table);
  const boundingBoxes = parseBoundingBoxes(body.boundingBoxes, table);
  const spatialOrder = parseSpatialOrder(body.spatialOrder, table);
  const includeDistance = body.includeDistance === void 0 ? void 0 : requireGeoField(table, body.includeDistance);
  const spatial = near.length > 0 || boundingBoxes.length > 0 || spatialOrder !== void 0;
  const parameters = table?.storage === "columns" ? [currentAppId] : [currentAppId, collection];
  const clauses = table?.storage === "columns" ? ["app_id = ?"] : ["app_id = ?", "collection = ?"];
  if (auth) {
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
      const declaredField2 = table?.fields[filter.field];
      const values = filter.value.map((value) => queryValue(value, declaredField2, env));
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
    const operators = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
    const operator = operators[filter.operator];
    if (!operator) throw new HttpError(400, "BAD_REQUEST", "Query operator is invalid.");
    clauses.push(`${expression} ${operator} ?`);
    const declaredField = table?.fields[filter.field];
    parameters.push(queryValue(filter.value, declaredField, env));
  }
  const sourceTable = table?.storage === "columns" ? sqlIdentifier(physicalTableName(currentAppId, collection)) : INTERNAL_TABLES.objects;
  if (body.count === true && !spatial) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${sourceTable} WHERE ${clauses.join(" AND ")}`
    ).bind(...parameters).first();
    return json({ count: row?.count ?? 0 });
  }
  const limit = integer(body.limit, 100, 1, 1e3, "limit");
  const skip = integer(body.skip, 0, 0, 1e4, "skip");
  const areaBounded = spatial ? pushSpatialAreaClauses(clauses, parameters, near, boundingBoxes, table, env) : false;
  if (spatial && !areaBounded) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Nearest-order scan matches too many points. Narrow the search with near() or withinBoundingBox()."
    );
  }
  const selectedFields = table?.storage === "columns" ? `${physicalFields(table).map(sqlIdentifier).join(", ")}, ` : "data, ";
  const fetchLimit = spatial ? SPATIAL_CANDIDATE_LIMIT + 1 : limit;
  const fetchOffset = spatial ? 0 : skip;
  const lastDirection = ordering.at(-1)?.direction === "asc" ? "ASC" : "DESC";
  const fetchOrder = spatial ? "id ASC" : `${ordering.length > 0 ? ordering.map((item) => `${queryField(item.field, parameters, env, table)} ${item.direction.toUpperCase()}`).join(", ") + ", " : "created_at DESC, "}id ${lastDirection}`;
  parameters.push(fetchLimit, fetchOffset);
  const result = await env.DB.prepare(
    `SELECT id, owner_id, ${selectedFields}created_at, updated_at
       FROM ${sourceTable}
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${fetchOrder}
      LIMIT ? OFFSET ?`
  ).bind(...parameters).all();
  let records = (result.results ?? []).map((row) => {
    const record = table?.storage === "columns" ? physicalObjectJson(row, table) : objectJson(row);
    return computedObjectJson(definition, collection, record);
  });
  if (spatial && records.length > SPATIAL_CANDIDATE_LIMIT) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Spatial search matches too many points. Narrow the search with a smaller radius or bounding box."
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
      auth?.user.id
    );
  }
  return json({ results: records });
}
export {
  INCLUDE_DEPTH_MESSAGE,
  SPATIAL_CANDIDATE_LIMIT,
  applySpatialQuery,
  expandRecords,
  expandRoute,
  expandedRecordMap,
  geoPoint,
  integer,
  parseBoundingBoxes,
  parseExpands,
  parseFilters,
  parseNear,
  parseOrder,
  parseSpatialOrder,
  pushSpatialAreaClauses,
  queryField,
  queryRoute,
  queryValue,
  recordPoint,
  requireGeoField
};
