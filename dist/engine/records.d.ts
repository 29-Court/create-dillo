import { type InternalUserRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type InternalObjectRow } from "../backend.js";
import { type SchemaDefinition } from "../index.js";
import { type NormalizedTable } from "../index.js";
import { type JsonValue } from "../backend.js";
import { type NormalizedField } from "../index.js";
import { type ArmadilloEnv } from "./environment.js";
import { type BindValue } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function now(): string;
export declare function userJson(row: InternalUserRow): JsonObject;
/** Declared profile fields for an expanded user. Email and undeclared keys stay off. */
export declare function publicProfileFields(raw: string | null | undefined, fields: Record<string, {
    type: string;
}> | undefined): JsonObject;
export declare function objectJson(row: InternalObjectRow): JsonObject;
export declare function computedObjectJson(definition: SchemaDefinition | undefined, collection: string, record: JsonObject): JsonObject;
export type PhysicalObjectRow = {
    id: string;
    owner_id: string;
    created_at: string;
    updated_at: string;
    [field: string]: unknown;
};
export declare function sqlIdentifier(value: string): string;
/** Indexed copy of a JSON table's team pointer. Column storage keeps the field itself. */
export declare function recordGroupId(table: NormalizedTable | undefined, data: JsonObject): string | null;
export declare function physicalFields(table: NormalizedTable): string[];
export declare function physicalValue(value: JsonValue | undefined, field: NormalizedField, env: ArmadilloEnv): BindValue | boolean;
export declare function physicalValues(data: JsonObject, table: NormalizedTable, env: ArmadilloEnv): (BindValue | boolean)[];
export declare function physicalData(row: PhysicalObjectRow, table: NormalizedTable): JsonObject;
export declare function physicalObjectJson(row: PhysicalObjectRow, table: NormalizedTable): JsonObject;
export declare function physicalRowAsObject(row: PhysicalObjectRow, table: NormalizedTable): InternalObjectRow;
export declare function findObject(env: ArmadilloEnv, currentAppId: string, collection: string, id: string, definition?: SchemaDefinition, requesterId?: string, write?: boolean): Promise<InternalObjectRow | null>;
export declare function tableRoute(request: Request, env: ArmadilloEnv, currentAppId: string, collection: string, definition: SchemaDefinition | undefined, id?: string, backend?: ArmadilloBackendDefinition): Promise<Response>;
