import { recordAccessClause } from "./permissions.js";
import type { ArmadilloStatement } from "../backend.js";
import { type InternalFileRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { maxJsonBytes } from "./http.js";
import { DEFAULT_MAX_JSON_BYTES } from "./http.js";
import { HttpError } from "./http.js";
import { boundedBody } from "./body.js";
import { isObject } from "./helpers/json.js";
import { FIELD } from "./http.js";
import { RESERVED_FIELDS } from "./http.js";
import { encoder } from "./http.js";
import { type SchemaDefinition } from "../index.js";
import { validateSchemaData } from "../index.js";
import { SchemaValidationError } from "../index.js";
import { INTERNAL_TABLES } from "../backend.js";
import { type BindValue } from "./environment.js";
import { sqlIdentifier } from "./records.js";
import { physicalTableName } from "../index.js";
import { now } from "./records.js";

export function fileJson(row: InternalFileRow): JsonObject {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    size: row.size,
    etag: row.etag,
    createdAt: row.created_at,
  };
}

export async function readJson(request: Request, env?: ArmadilloEnv): Promise<Record<string, unknown>> {
  const maximum = env ? maxJsonBytes(env) : DEFAULT_MAX_JSON_BYTES;
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > maximum) {
    throw new HttpError(413, "BAD_REQUEST", "JSON request is too large.");
  }
  const text = request.body ? await new Response(boundedBody(request.body, maximum)).text() : "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "Request body must be a JSON object.");
  }
}

function payloadByteLimit(env?: ArmadilloEnv): number {
  return env ? maxJsonBytes(env) : DEFAULT_MAX_JSON_BYTES;
}

export function validateData(value: unknown, env?: ArmadilloEnv): { data: JsonObject; encoded: string } {
  if (!isObject(value)) {
    throw new HttpError(422, "VALIDATION_ERROR", "data must be a JSON object.", {
      data: "Expected an object",
    });
  }
  for (const key of Object.keys(value)) {
    if (!FIELD.test(key)) {
      throw new HttpError(422, "VALIDATION_ERROR", "A field name is invalid.", {
        [key]: "Use letters, numbers, and underscores; begin with a letter",
      });
    }
    if (RESERVED_FIELDS.has(key)) {
      throw new HttpError(422, "VALIDATION_ERROR", `\`${key}\` is reserved.`, {
        [key]: "Reserved by Armadillo",
      });
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "data must be JSON-serializable.");
  }
  if (encoder.encode(encoded).byteLength > payloadByteLimit(env)) {
    throw new HttpError(413, "BAD_REQUEST", "Object data is too large.");
  }
  return { data: value as JsonObject, encoded };
}

export function validateFunctionData(value: unknown, env?: ArmadilloEnv): { data: JsonObject; encoded: string } {
  if (!isObject(value)) {
    throw new HttpError(422, "VALIDATION_ERROR", "data must be a JSON object.", {
      data: "Expected an object",
    });
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "data must be JSON-serializable.");
  }
  if (encoder.encode(encoded).byteLength > payloadByteLimit(env)) {
    throw new HttpError(413, "BAD_REQUEST", "Object data is too large.");
  }
  return { data: value as JsonObject, encoded };
}

export function schemaData(
  definition: SchemaDefinition | undefined,
  collection: string,
  data: JsonObject,
  partial: boolean,
  env?: ArmadilloEnv,
): { data: JsonObject; encoded: string } {
  try {
    return validateData(validateSchemaData(definition, collection, data, partial), env);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new HttpError(422, "VALIDATION_ERROR", error.message, error.fields);
    }
    throw error;
  }
}

export function acceptsContentType(actual: string, accepted: string[]): boolean {
  const normalized = actual.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return accepted.some((pattern) => {
    const wanted = pattern.toLowerCase();
    return wanted.endsWith("/*")
      ? normalized.startsWith(wanted.slice(0, -1))
      : normalized === wanted;
  });
}

export async function validateSchemaLinks(
  env: ArmadilloEnv,
  currentAppId: string,
  ownerId: string,
  definition: SchemaDefinition | undefined,
  collection: string,
  data: JsonObject,
): Promise<void> {
  const fields = definition?.normalized.tables[collection]?.fields;
  if (!fields) return;
  const issues: Record<string, string> = {};

  await Promise.all(Object.entries(fields).map(async ([fieldName, field]) => {
    const value = data[fieldName];
    if (typeof value !== "string") return;
    if (field.type === "file") {
      const stored = await env.DB.prepare(
        `SELECT content_type, size FROM ${INTERNAL_TABLES.files}
          WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 LIMIT 1`,
      ).bind(currentAppId, value, ownerId).first<{ content_type: string; size: number }>();
      if (!stored) {
        issues[fieldName] = "Upload this file before attaching it";
      } else if (field.contentTypes && !acceptsContentType(stored.content_type, field.contentTypes)) {
        issues[fieldName] = `Use ${field.contentTypes.join(" or ")}`;
      } else if (field.maxBytes !== undefined && stored.size > field.maxBytes) {
        issues[fieldName] = `File must be at most ${field.maxBytes} bytes`;
      }
      return;
    }
    if (field.type !== "pointer") return;
    let found: unknown;
    if (field.target === "_User") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`,
      ).bind(currentAppId, value).first();
    } else if (field.target === "_Team") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.groups} AS g
          JOIN ${INTERNAL_TABLES.groupMembers} AS m
            ON m.app_id = g.app_id AND m.group_id = g.id
          WHERE g.app_id = ?1 AND g.id = ?2 AND m.user_id = ?3 LIMIT 1`,
      ).bind(currentAppId, value, ownerId).first();
    } else {
      const targetName = field.target ?? "";
      const target = definition?.normalized.tables[targetName];
      const bindings: BindValue[] = target?.storage === "columns"
        ? [currentAppId, value]
        : [currentAppId, targetName, value];
      const access = recordAccessClause(target, currentAppId, ownerId, bindings, false);
      const tableName = target?.storage === "columns"
        ? sqlIdentifier(physicalTableName(currentAppId, targetName))
        : INTERNAL_TABLES.objects;
      found = await env.DB.prepare(
        `SELECT 1 FROM ${tableName}
          WHERE app_id = ?1 ${target?.storage === "columns" ? "" : "AND collection = ?2"}
            AND id = ?${target?.storage === "columns" ? "2" : "3"}
            ${access ? `AND (${access})` : ""} LIMIT 1`,
      ).bind(...bindings).first();
    }
    if (!found) issues[fieldName] = `Referenced ${field.target ?? "record"} does not exist or is not accessible`;
  }));

  if (Object.keys(issues).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Object references do not match its Armadillo schema.", issues);
  }
}

export function declaredFileLinkStatements(
  env: ArmadilloEnv,
  currentAppId: string,
  ownerId: string,
  definition: SchemaDefinition | undefined,
  collection: string,
  objectId: string,
  data: JsonObject,
): ArmadilloStatement[] {
  const fields = definition?.normalized.tables[collection]?.fields ?? {};
  const statements: ArmadilloStatement[] = [env.DB.prepare(
    `DELETE FROM ${INTERNAL_TABLES.fileLinks}
      WHERE app_id = ?1 AND collection = ?2 AND object_id = ?3 AND relation = 'field'`,
  ).bind(currentAppId, collection, objectId)];
  for (const [fieldName, field] of Object.entries(fields)) {
    const fileId = data[fieldName];
    if (field.type !== "file" || typeof fileId !== "string") continue;
    statements.push(env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.fileLinks}
         (app_id, collection, object_id, file_id, owner_id, relation, field_name, position, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'field', ?6, 0, ?7)`,
    ).bind(currentAppId, collection, objectId, fileId, ownerId, fieldName, now()));
  }
  return statements;
}

export async function syncDeclaredFileLinks(...args: Parameters<typeof declaredFileLinkStatements>): Promise<void> {
  await args[0].DB.batch(declaredFileLinkStatements(...args));
}
