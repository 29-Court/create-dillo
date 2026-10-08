import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../migrations.js";
import {
  buildPhysicalSchemaMigration,
  formatSchemaMigration,
  planSchemaMigration,
  SchemaValidationError,
  validateSchemaData
} from "../index.js";
import {
  dropUserProfileUniqueIndexSql,
  removedUserProfileFields,
  uniqueUserProfileFields,
  userProfileJsonPath,
  userProfileUniqueIndexSql
} from "../schema.js";
import { normalizeBindings } from "./bindings.js";
function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}
function sqliteValue(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`SQLite cannot bind a ${typeof value} value.`);
}
class LocalSqliteStatement {
  constructor(owner, query, values = []) {
    this.owner = owner;
    this.query = query;
    this.values = values;
  }
  owner;
  query;
  values;
  bind(...values) {
    return new LocalSqliteStatement(this.owner, this.query, values);
  }
  belongsTo(database) {
    return this.owner === database;
  }
  normalized() {
    const { sql, values } = normalizeBindings(this.query, this.values);
    return { sql, values: values.map(sqliteValue) };
  }
  firstSync() {
    const { sql, values } = this.normalized();
    return this.owner.native.prepare(sql).get(...values) ?? null;
  }
  allSync() {
    const { sql, values } = this.normalized();
    return { results: this.owner.native.prepare(sql).all(...values) };
  }
  runSync() {
    const { sql, values } = this.normalized();
    const result = this.owner.native.prepare(sql).run(...values);
    return { meta: { changes: Number(result.changes) } };
  }
  first() {
    return this.owner.run(() => this.firstSync());
  }
  all() {
    return this.owner.run(() => this.allSync());
  }
  run() {
    return this.owner.run(() => this.runSync());
  }
}
function applyPackageMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _armadillo_local_migrations (
      name TEXT NOT NULL PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  for (const migration of migrations) {
    const { id: name, sql, checksum: nextChecksum } = migration;
    if (checksum(sql) !== nextChecksum) throw new Error(`Core migration checksum mismatch: ${name}`);
    const applied = database.prepare(
      "SELECT checksum FROM _armadillo_local_migrations WHERE name = ?"
    ).get(name);
    if (applied) {
      if (applied.checksum !== nextChecksum) {
        throw new Error(`Bundled migration ${name} changed after it was applied.`);
      }
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare(
        "INSERT INTO _armadillo_local_migrations (name, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(name, nextChecksum, (/* @__PURE__ */ new Date()).toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
function applyApplicationMigrations(database, files) {
  for (const file of files) {
    const pathname = resolve(file);
    const name = `app:${basename(pathname)}`;
    const sql = readFileSync(pathname, "utf8");
    const nextChecksum = checksum(sql);
    const applied = database.prepare(
      "SELECT checksum FROM _armadillo_local_migrations WHERE name = ?"
    ).get(name);
    if (applied) {
      if (applied.checksum !== nextChecksum) {
        throw new Error(`Application migration ${name} changed after it was applied.`);
      }
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare(
        "INSERT INTO _armadillo_local_migrations (name, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(name, nextChecksum, (/* @__PURE__ */ new Date()).toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
function assertUserProfileRemoval(database, appId, current, desired) {
  const blocked = [];
  for (const fieldName of removedUserProfileFields(current, desired)) {
    const hit = database.prepare(
      `SELECT id FROM _armadillo_users WHERE app_id = ? AND json_type(profile, ?) IS NOT NULL LIMIT 1`
    ).get(appId, userProfileJsonPath(fieldName));
    if (hit) blocked.push(fieldName);
  }
  if (blocked.length === 0) return;
  throw new Error([
    "Schema change stopped.",
    "",
    "Armadillo will not guess.",
    "",
    "Potentially destructive",
    ...blocked.map((fieldName) => `  remove field users.${fieldName}; profile still holds \`${fieldName}\``),
    "",
    "Nothing was changed."
  ].join("\n"));
}
function applyUserProfileIndexes(database, current, desired) {
  const previous = new Set(uniqueUserProfileFields(current));
  const next = new Set(uniqueUserProfileFields(desired));
  for (const fieldName of previous) {
    if (!next.has(fieldName)) database.exec(dropUserProfileUniqueIndexSql(fieldName));
  }
  for (const fieldName of next) {
    try {
      database.exec(userProfileUniqueIndexSql(fieldName));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("unique")) {
        throw new Error(`Unique profile field \`${fieldName}\` already has duplicate values. Startup stopped. Nothing was changed.`);
      }
      throw error;
    }
  }
}
function applyApplicationSchema(database, appId, schema, allowUnsafeChanges) {
  if (!schema) return;
  const row = database.prepare(
    "SELECT schema_json FROM _armadillo_schema_state WHERE app_id = ? LIMIT 1"
  ).get(appId);
  const current = row ? JSON.parse(row.schema_json) : void 0;
  const desired = schema.normalized;
  const plan = planSchemaMigration(current, desired);
  if (!allowUnsafeChanges && (plan.requiresAuthorization.length > 0 || plan.destructive.length > 0)) {
    throw new Error(
      `${formatSchemaMigration(plan)}
Nothing was changed. Review the plan, then set allowUnsafeSchemaChanges for this startup if you accept it.`
    );
  }
  assertUserProfileRemoval(database, appId, current, desired);
  const physical = buildPhysicalSchemaMigration(appId, current, desired, "sqlite");
  if (physical.unsupported.length > 0) {
    throw new Error(`SQLite cannot apply this schema:
  - ${physical.unsupported.join("\n  - ")}`);
  }
  const schemaJson = JSON.stringify(desired);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [tableName, table] of Object.entries(desired.tables)) {
      const previous = current?.tables[tableName];
      const changedJson = table.storage === "json" && JSON.stringify(previous) !== JSON.stringify(table);
      const newColumns = table.storage === "columns" && previous?.storage !== "columns";
      if (!changedJson && !newColumns) continue;
      let hasRows = false;
      const rows = database.prepare(
        "SELECT id, data FROM _armadillo_objects WHERE app_id = ? AND collection = ?"
      ).iterate(appId, tableName);
      for (const row2 of rows) {
        hasRows = true;
        if (!previous && !allowUnsafeChanges) {
          throw new Error(`Cannot adopt existing ${tableName} records under a new schema without review. Nothing was changed. Set allowUnsafeSchemaChanges for one startup after reviewing access and data.`);
        }
        let data;
        try {
          const parsed = JSON.parse(row2.data);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          data = parsed;
        } catch {
          throw new Error(`Cannot migrate ${tableName} record ${row2.id}: stored JSON is invalid. Repair it before retrying.`);
        }
        try {
          validateSchemaData(schema, tableName, data, false);
        } catch (error) {
          if (!(error instanceof SchemaValidationError)) throw error;
          const [field, issue] = Object.entries(error.fields)[0] ?? ["record", error.message];
          throw new Error(`Cannot migrate ${tableName} record ${row2.id}: ${field} is invalid (${issue}). Repair it before retrying.`);
        }
        if (newColumns) {
          for (const [fieldName, field] of Object.entries(table.fields)) {
            if (field.default === void 0) continue;
            if (data[fieldName] === null || field.type === "geo" && !(fieldName in data)) {
              throw new Error(`Cannot migrate ${tableName} record ${row2.id}: ${fieldName} needs an explicit backfill before conversion.`);
            }
          }
        }
      }
      if (hasRows && changedJson) {
        for (const [fieldName, field] of Object.entries(table.fields)) {
          if (field.default === void 0) continue;
          database.prepare(
            `UPDATE _armadillo_objects SET data = json_set(data, '$.${fieldName}', json(?))
               WHERE app_id = ? AND collection = ? AND json_type(data, '$.${fieldName}') IS NULL`
          ).run(JSON.stringify(field.default), appId, tableName);
        }
      }
    }
    for (const statement of physical.statements) database.exec(statement);
    applyUserProfileIndexes(database, current, desired);
    database.prepare(`
      INSERT INTO _armadillo_schema_state (app_id, schema_json, checksum, applied_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (app_id) DO UPDATE SET
        schema_json = excluded.schema_json,
        checksum = excluded.checksum,
        applied_at = excluded.applied_at
    `).run(appId, schemaJson, checksum(schemaJson), (/* @__PURE__ */ new Date()).toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
class LocalSqliteDatabase {
  native;
  transactionContext = new AsyncLocalStorage();
  queue = Promise.resolve();
  closing;
  batchSequence = 0;
  constructor(pathname, options) {
    const path = pathname === ":memory:" ? pathname : resolve(pathname);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.native = new DatabaseSync(path);
    this.native.exec("PRAGMA foreign_keys = ON");
    this.native.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.native.exec("PRAGMA journal_mode = WAL");
      this.native.exec("PRAGMA synchronous = NORMAL");
    }
    try {
      applyPackageMigrations(this.native);
      applyApplicationMigrations(this.native, options.migrationFiles ?? []);
      applyApplicationSchema(
        this.native,
        options.appId,
        options.schema,
        options.allowUnsafeSchemaChanges ?? false
      );
    } catch (error) {
      this.native.close();
      throw error;
    }
  }
  prepare(query) {
    return new LocalSqliteStatement(this, query);
  }
  run(operation) {
    if (this.transactionContext.getStore()?.active) return Promise.resolve().then(operation);
    if (this.closing) return Promise.reject(new Error("Local SQLite database is closing or closed."));
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => void 0, () => void 0);
    return pending;
  }
  batch(statements) {
    return this.run(() => {
      const local = statements.map((statement) => {
        if (!(statement instanceof LocalSqliteStatement) || !statement.belongsTo(this)) {
          throw new TypeError("A local SQLite batch can only contain statements from the same database.");
        }
        return statement;
      });
      const savepoint = this.transactionContext.getStore()?.active ? `armadillo_batch_${++this.batchSequence}` : void 0;
      this.native.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      try {
        const results = local.map((statement) => statement.runSync());
        this.native.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
        return results;
      } catch (error) {
        if (savepoint) {
          this.native.exec(`ROLLBACK TO ${savepoint}`);
          this.native.exec(`RELEASE ${savepoint}`);
        } else this.native.exec("ROLLBACK");
        throw error;
      }
    });
  }
  transaction(handler) {
    if (this.transactionContext.getStore()?.active) {
      return Promise.reject(new Error("Nested callback transactions are not supported; use batch() within the current transaction."));
    }
    return this.run(async () => {
      this.native.exec("BEGIN IMMEDIATE");
      const context = { active: true };
      try {
        const result = await this.transactionContext.run(context, () => handler(this));
        this.native.exec("COMMIT");
        return result;
      } catch (error) {
        this.native.exec("ROLLBACK");
        throw error;
      } finally {
        context.active = false;
      }
    });
  }
  async close() {
    if (this.transactionContext.getStore()?.active) {
      throw new Error("Cannot close a local SQLite database inside its transaction.");
    }
    this.closing ??= this.queue.then(() => {
      this.native.close();
    });
    await this.closing;
  }
}
export {
  LocalSqliteDatabase
};
