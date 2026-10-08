const EMPTY_SCHEMA = { tables: {} };
function storage(table) {
  return table?.storage ?? "json";
}
function indexes(table) {
  return table?.indexes ?? {};
}
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function fieldConstraint(field, key) {
  return field[key];
}
function planSchemaMigration(current, desired) {
  const before = current ?? EMPTY_SCHEMA;
  const changes = [];
  const add = (severity, path, message) => {
    changes.push({ severity, path, message });
  };
  for (const tableName of Object.keys(desired.tables).sort()) {
    const nextTable = desired.tables[tableName];
    if (!nextTable) continue;
    const previousTable = before.tables[tableName];
    if (!previousTable) {
      add("safe", tableName, `add table ${tableName}`);
      continue;
    }
    if (previousTable.read !== nextTable.read) {
      if (previousTable.read === "owner" && nextTable.read === "public") {
        add(
          "requires-authorization",
          tableName,
          `make ${tableName} readable without authentication`
        );
      } else {
        add("safe", tableName, `restrict ${tableName} reads to record owners`);
      }
    }
    if (previousTable.writes !== nextTable.writes) {
      add(
        nextTable.writes === "none" ? "safe" : "requires-authorization",
        tableName,
        nextTable.writes === "none" ? `close ${tableName} record writes` : `enable ${tableName} record writes`
      );
    }
    if (storage(previousTable) !== storage(nextTable)) {
      add(
        storage(nextTable) === "columns" ? "requires-authorization" : "destructive",
        tableName,
        storage(nextTable) === "columns" ? `materialize ${tableName} as physical columns; existing JSON records need a verified backfill` : `move ${tableName} back to schemaless JSON storage`
      );
    }
    if (!sameValue(previousTable.team, nextTable.team)) {
      add(
        "requires-authorization",
        tableName,
        nextTable.team ? `change ${tableName} to team-scoped access through ${nextTable.team.field}` : `remove team-scoped access from ${tableName}`
      );
    }
    const previousIndexes = indexes(previousTable);
    const nextIndexes = indexes(nextTable);
    for (const indexName of Object.keys(nextIndexes).sort()) {
      const path = `${tableName}.${indexName}`;
      if (!previousIndexes[indexName]) {
        add("safe", path, `add index ${path}`);
      } else if (!sameValue(previousIndexes[indexName], nextIndexes[indexName])) {
        add("destructive", path, `change index ${path}`);
      }
    }
    for (const indexName of Object.keys(previousIndexes).sort()) {
      if (!nextIndexes[indexName]) {
        const path = `${tableName}.${indexName}`;
        add("destructive", path, `remove index ${path}`);
      }
    }
    for (const fieldName of Object.keys(nextTable.fields).sort()) {
      const path = `${tableName}.${fieldName}`;
      const nextField = nextTable.fields[fieldName];
      if (!nextField) continue;
      const previousField = previousTable.fields[fieldName];
      if (!previousField) {
        if (nextField.required) {
          add(
            "requires-authorization",
            path,
            `add required field ${path}; existing records need a backfill`
          );
        } else {
          add("safe", path, `add optional field ${path}`);
        }
        continue;
      }
      if (previousField.type !== nextField.type) {
        add(
          "destructive",
          path,
          `change ${path} from ${previousField.type} to ${nextField.type}`
        );
        continue;
      }
      if (!sameValue(previousField.format, nextField.format)) {
        add("requires-authorization", path, `change the format of ${path}`);
      }
      if (previousField.nullable === true !== (nextField.nullable === true)) {
        add(
          nextField.nullable === true ? "safe" : "requires-authorization",
          path,
          nextField.nullable === true ? `allow null for ${path}` : `stop allowing null for ${path}; existing nulls need a backfill`
        );
      }
      if (previousField.type === "pointer" && previousField.target !== nextField.target) {
        add(
          "destructive",
          path,
          `retarget ${path} from ${previousField.target ?? "unknown"} to ${nextField.target ?? "unknown"}`
        );
        continue;
      }
      if (previousField.type === "file") {
        if (!sameValue(previousField.contentTypes, nextField.contentTypes)) {
          const relaxed = previousField.contentTypes !== void 0 && nextField.contentTypes === void 0;
          add(
            relaxed ? "safe" : "requires-authorization",
            path,
            `${relaxed ? "remove" : "change"} accepted content types for ${path}`
          );
        }
        if (!sameValue(previousField.maxBytes, nextField.maxBytes)) {
          const relaxed = nextField.maxBytes === void 0 || previousField.maxBytes !== void 0 && nextField.maxBytes > previousField.maxBytes;
          add(
            relaxed ? "safe" : "requires-authorization",
            path,
            `${relaxed ? "relax" : "tighten"} the file size limit for ${path}`
          );
        }
      }
      if (previousField.type === "geo") {
        if (previousField.geoIndex !== nextField.geoIndex) {
          add(
            previousField.geoIndex && !nextField.geoIndex ? "destructive" : "safe",
            path,
            `${nextField.geoIndex ? "add or change" : "remove"} the spatial index for ${path}`
          );
        }
        for (const constraint of ["minAltitude", "maxAltitude"]) {
          if (!sameValue(previousField[constraint], nextField[constraint])) {
            add("requires-authorization", path, `change ${constraint} for ${path}`);
          }
        }
      }
      if (previousField.required !== nextField.required) {
        if (nextField.required) {
          add(
            "requires-authorization",
            path,
            `make ${path} required; existing records need a backfill`
          );
        } else {
          add("safe", path, `make ${path} optional`);
        }
      }
      if (!sameValue(previousField.default, nextField.default)) {
        add(
          "requires-authorization",
          path,
          `change the default for ${path}; this affects future writes only`
        );
      }
      const previousMin = fieldConstraint(previousField, "min");
      const nextMin = fieldConstraint(nextField, "min");
      if (!sameValue(previousMin, nextMin)) {
        const stricter = nextMin !== void 0 && (previousMin === void 0 || nextMin > previousMin);
        add(
          stricter ? "requires-authorization" : "safe",
          path,
          `${stricter ? "tighten" : "relax"} the minimum for ${path}`
        );
      }
      const previousMax = fieldConstraint(previousField, "max");
      const nextMax = fieldConstraint(nextField, "max");
      if (!sameValue(previousMax, nextMax)) {
        const stricter = nextMax !== void 0 && (previousMax === void 0 || nextMax < previousMax);
        add(
          stricter ? "requires-authorization" : "safe",
          path,
          `${stricter ? "tighten" : "relax"} the maximum for ${path}`
        );
      }
    }
    for (const fieldName of Object.keys(previousTable.fields).sort()) {
      if (!nextTable.fields[fieldName]) {
        const path = `${tableName}.${fieldName}`;
        add("destructive", path, `remove field ${path}`);
      }
    }
  }
  for (const tableName of Object.keys(before.tables).sort()) {
    if (!desired.tables[tableName]) {
      add("destructive", tableName, `remove table ${tableName}`);
    }
  }
  return {
    changes,
    safe: changes.filter((change) => change.severity === "safe"),
    requiresAuthorization: changes.filter((change) => change.severity === "requires-authorization"),
    destructive: changes.filter((change) => change.severity === "destructive")
  };
}
function formatSchemaMigration(plan) {
  if (plan.changes.length === 0) return "Schema matches the deployed schema.\n";
  const blocked = plan.destructive.length > 0 || plan.requiresAuthorization.length > 0;
  const line = (change) => `  ${change.message}`;
  if (!blocked) {
    return [
      "Schema changes",
      "",
      ...plan.safe.map(line),
      "",
      "Migration is non-destructive.",
      ""
    ].join("\n");
  }
  const lines = ["Schema change stopped.", "", "Armadillo will not guess.", ""];
  if (plan.destructive.length > 0) {
    lines.push("Potentially destructive", ...plan.destructive.map(line), "");
  }
  if (plan.requiresAuthorization.length > 0) {
    lines.push("Needs an explicit decision", ...plan.requiresAuthorization.map(line), "");
  }
  if (plan.safe.length > 0) {
    lines.push("Also safe, and not applied", ...plan.safe.map(line), "");
  }
  return lines.join("\n");
}
const SYSTEM_COLUMNS = {
  id: "id",
  ownerId: "owner_id",
  createdAt: "created_at",
  updatedAt: "updated_at"
};
function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
function slug(value, maximum = 16) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (result || "app").slice(0, maximum);
}
function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function physicalTableName(appId, tableName) {
  return `_armadillo_${slug(appId)}_${slug(tableName)}_${shortHash(`${appId}:${tableName}`)}`;
}
function literal(value, dialect) {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return dialect === "postgres" ? String(value) : value ? "1" : "0";
  return String(value);
}
function fieldDefaultLiteral(field, dialect) {
  const value = field.type === "json" ? JSON.stringify(field.default) : field.default;
  return literal(value, dialect);
}
function columnType(field, dialect) {
  if (field.type === "integer") return dialect === "postgres" ? "BIGINT" : "INTEGER";
  if (field.type === "number") return dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
  if (field.type === "boolean") return dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  return "TEXT";
}
function physicalGeoColumns(fieldName) {
  return [`${fieldName}__lat`, `${fieldName}__lng`, `${fieldName}__alt`];
}
function geoColumnDefinitions(name, field, dialect) {
  const [latitude, longitude, altitude] = physicalGeoColumns(name).map(identifier);
  const type = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
  const defaultPoint = field.default && typeof field.default === "object" ? field.default : void 0;
  const value = (candidate) => typeof candidate === "number" ? ` DEFAULT ${candidate}` : "";
  return [
    `${latitude} ${type}${field.required ? " NOT NULL" : ""}${value(defaultPoint?.latitude)} CHECK (${latitude} BETWEEN -90 AND 90)`,
    `${longitude} ${type}${field.required ? " NOT NULL" : ""}${value(defaultPoint?.longitude)} CHECK (${longitude} BETWEEN -180 AND 180)`,
    `${altitude} ${type}${value(defaultPoint?.altitude)}`
  ];
}
function columnDefinition(name, field, dialect) {
  const column = identifier(name);
  const checks = [];
  if (field.type === "boolean" && dialect === "sqlite") checks.push(`${column} IN (0, 1)`);
  if (field.type === "json" && dialect === "sqlite") checks.push(`json_valid(${column})`);
  if ((field.type === "string" || field.type === "email") && field.min !== void 0) {
    checks.push(`length(${column}) >= ${field.min}`);
  }
  if ((field.type === "string" || field.type === "email") && field.max !== void 0) {
    checks.push(`length(${column}) <= ${field.max}`);
  }
  if ((field.type === "integer" || field.type === "number") && field.min !== void 0) {
    checks.push(`${column} >= ${field.min}`);
  }
  if ((field.type === "integer" || field.type === "number") && field.max !== void 0) {
    checks.push(`${column} <= ${field.max}`);
  }
  return [
    column,
    columnType(field, dialect),
    field.required ? "NOT NULL" : "",
    field.default === void 0 ? "" : `DEFAULT ${fieldDefaultLiteral(field, dialect)}`,
    checks.length > 0 ? `CHECK (${checks.join(" AND ")})` : ""
  ].filter(Boolean).join(" ");
}
function physicalColumn(fieldName) {
  return SYSTEM_COLUMNS[fieldName] ?? fieldName;
}
function createTableStatement(appId, tableName, table, dialect) {
  const name = physicalTableName(appId, tableName);
  const columns = [
    "app_id TEXT NOT NULL",
    "id TEXT NOT NULL",
    "owner_id TEXT NOT NULL",
    ...Object.entries(table.fields).flatMap(([fieldName, field]) => field.type === "geo" ? geoColumnDefinitions(fieldName, field, dialect) : [columnDefinition(fieldName, field, dialect)]),
    "created_at TEXT NOT NULL",
    "updated_at TEXT NOT NULL",
    "PRIMARY KEY (app_id, id)",
    "FOREIGN KEY (app_id, owner_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE"
  ];
  for (const [fieldName, field] of Object.entries(table.fields)) {
    if (field.type !== "pointer" && field.type !== "file") continue;
    let target;
    if (field.type === "file") target = "_armadillo_files";
    else if (field.target === "_User") target = "_armadillo_users";
    else if (field.target === "_Team") target = "_armadillo_groups";
    if (target) {
      const onDelete = field.type === "file" && !field.required ? " ON DELETE SET NULL" : "";
      columns.push(
        `FOREIGN KEY (app_id, ${identifier(fieldName)}) REFERENCES ${identifier(target)} (app_id, id)${onDelete}`
      );
    }
  }
  return `CREATE TABLE IF NOT EXISTS ${identifier(name)} (
  ${columns.join(",\n  ")}
)${dialect === "sqlite" ? " STRICT" : ""}`;
}
function createIndexStatement(appId, tableName, indexName, index, table) {
  const physicalTable = physicalTableName(appId, tableName);
  const physicalIndex = `_armadillo_i_${slug(indexName, 24)}_${shortHash(`${appId}:${tableName}:${indexName}`)}`;
  const indexed = index.fields.flatMap((field) => table?.fields[field]?.type === "geo" ? physicalGeoColumns(field).slice(0, 2) : [physicalColumn(field)]);
  const fields = ["app_id", ...indexed].map(identifier).join(", ");
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${identifier(physicalIndex)} ON ${identifier(physicalTable)} (${fields})`;
}
function createGeoIndexStatement(appId, tableName, fieldName, indexName) {
  const table = physicalTableName(appId, tableName);
  const physicalIndex = `_armadillo_g_${slug(indexName, 24)}_${shortHash(`${appId}:${tableName}:${fieldName}:geo`)}`;
  const [latitude, longitude] = physicalGeoColumns(fieldName);
  return `CREATE INDEX IF NOT EXISTS ${identifier(physicalIndex)} ON ${identifier(table)} (${identifier("app_id")}, ${identifier(latitude)}, ${identifier(longitude)})`;
}
function jsonValueExpression(fieldName, field, dialect) {
  const path = fieldName.replaceAll("'", "''");
  const extracted = dialect === "postgres" ? `CAST(data AS jsonb) ->> '${path}'` : `json_extract(data, '$.${path}')`;
  let value = extracted;
  if (field.type === "json") {
    value = dialect === "postgres" ? `(CAST(data AS jsonb) -> '${path}')::text` : `CASE json_type(data, '$.${path}')
          WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
          WHEN 'null' THEN 'null' WHEN 'text' THEN json_quote(${extracted})
          ELSE ${extracted} END`;
  }
  if (field.type === "integer") value = `CAST(${extracted} AS ${dialect === "postgres" ? "BIGINT" : "INTEGER"})`;
  if (field.type === "number") value = `CAST(${extracted} AS ${dialect === "postgres" ? "DOUBLE PRECISION" : "REAL"})`;
  if (field.type === "boolean") {
    value = dialect === "postgres" ? `CAST(${extracted} AS BOOLEAN)` : `CAST(${extracted} AS INTEGER)`;
  }
  if (field.default === void 0) return value;
  const missing = dialect === "postgres" ? `NOT (CAST(data AS jsonb) ? '${path}')` : `json_type(data, '$.${path}') IS NULL`;
  return `CASE WHEN ${missing} THEN ${fieldDefaultLiteral(field, dialect)} ELSE ${value} END`;
}
function backfillStatement(appId, tableName, table, dialect) {
  const fieldEntries = Object.entries(table.fields);
  const fieldColumns = fieldEntries.flatMap(([name, field]) => field.type === "geo" ? physicalGeoColumns(name) : [name]);
  const fieldValues = fieldEntries.flatMap(([name, field]) => {
    if (field.type !== "geo") return [jsonValueExpression(name, field, dialect)];
    const extract = (part) => dialect === "postgres" ? `CAST(CAST(data AS jsonb) #>> '{${name},${part}}' AS DOUBLE PRECISION)` : `CAST(json_extract(data, '$.${name}.${part}') AS REAL)`;
    return [extract("latitude"), extract("longitude"), extract("altitude")];
  });
  const columns = ["app_id", "id", "owner_id", ...fieldColumns, "created_at", "updated_at"];
  const values = [
    "app_id",
    "id",
    "owner_id",
    ...fieldValues,
    "created_at",
    "updated_at"
  ];
  return `INSERT INTO ${identifier(physicalTableName(appId, tableName))} (${columns.map(identifier).join(", ")})
SELECT ${values.join(", ")} FROM _armadillo_objects
WHERE app_id = ${literal(appId, dialect)} AND collection = ${literal(tableName, dialect)}
ON CONFLICT (app_id, id) DO NOTHING`;
}
function buildPhysicalSchemaMigration(appId, current, desired, dialect) {
  const before = current ?? EMPTY_SCHEMA;
  const statements = [];
  const unsupported = [];
  for (const tableName of Object.keys(desired.tables).sort()) {
    const next = desired.tables[tableName];
    const previous = before.tables[tableName];
    if (previous?.storage === "columns" && next?.storage === "json") {
      unsupported.push(`${tableName} cannot move from column storage back to JSON without an explicit backfill; old JSON rows may be stale`);
      continue;
    }
    if (!next || storage(next) !== "columns") continue;
    const nullable = Object.entries(next.fields).find(([, field]) => field.nullable);
    if (nullable) {
      unsupported.push(`${tableName}.${nullable[0]} is nullable; column storage cannot distinguish explicit null from an absent value`);
      continue;
    }
    const wasColumns = storage(previous) === "columns";
    if (!previous || !wasColumns) {
      statements.push(createTableStatement(appId, tableName, next, dialect));
      statements.push(backfillStatement(appId, tableName, next, dialect));
      for (const [indexName, index] of Object.entries(indexes(next))) {
        statements.push(createIndexStatement(appId, tableName, indexName, index, next));
      }
      for (const [fieldName, field] of Object.entries(next.fields)) {
        if (field.type === "geo" && field.geoIndex) {
          statements.push(createGeoIndexStatement(appId, tableName, fieldName, field.geoIndex));
        }
      }
      continue;
    }
    statements.push(createTableStatement(appId, tableName, next, dialect));
    for (const [fieldName, field] of Object.entries(next.fields)) {
      const oldField = previous.fields[fieldName];
      if (!oldField) {
        if (field.required && field.default === void 0) {
          unsupported.push(`${tableName}.${fieldName} needs a backfill before its NOT NULL column can be added`);
        } else if (field.type === "geo") {
          statements.push(...geoColumnDefinitions(fieldName, field, dialect).map((column) => `ALTER TABLE ${identifier(physicalTableName(appId, tableName))} ADD COLUMN ${column}`));
        } else {
          statements.push(
            `ALTER TABLE ${identifier(physicalTableName(appId, tableName))} ADD COLUMN ${columnDefinition(fieldName, field, dialect)}`
          );
        }
      } else if (!sameValue(oldField, field)) {
        unsupported.push(`${tableName}.${fieldName} needs an explicit column backfill/rebuild`);
      }
    }
    for (const fieldName of Object.keys(previous.fields)) {
      if (!next.fields[fieldName]) unsupported.push(`${tableName}.${fieldName} needs an explicit column rebuild`);
    }
    const previousIndexes = indexes(previous);
    for (const [indexName, index] of Object.entries(indexes(next))) {
      if (!previousIndexes[indexName] || sameValue(previousIndexes[indexName], index)) {
        statements.push(createIndexStatement(appId, tableName, indexName, index, next));
      } else {
        unsupported.push(`${tableName}.${indexName} needs an explicit index replacement`);
      }
    }
    for (const [fieldName, field] of Object.entries(next.fields)) {
      if (field.type === "geo" && field.geoIndex) {
        statements.push(createGeoIndexStatement(appId, tableName, fieldName, field.geoIndex));
      }
    }
    for (const indexName of Object.keys(previousIndexes)) {
      if (!indexes(next)[indexName]) unsupported.push(`${tableName}.${indexName} needs an explicit index removal`);
    }
  }
  for (const [tableName, previous] of Object.entries(before.tables)) {
    if (storage(previous) === "columns" && !desired.tables[tableName]) {
      unsupported.push(`${tableName} needs an explicit physical table removal`);
    }
  }
  return { statements, unsupported };
}
export {
  buildPhysicalSchemaMigration,
  formatSchemaMigration,
  physicalGeoColumns,
  physicalTableName,
  planSchemaMigration
};
