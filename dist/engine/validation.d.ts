import type { ArmadilloStatement } from "../backend.js";
import { type InternalFileRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { type SchemaDefinition } from "../index.js";
export declare function fileJson(row: InternalFileRow): JsonObject;
export declare function readJson(request: Request, env?: ArmadilloEnv): Promise<Record<string, unknown>>;
export declare function validateData(value: unknown, env?: ArmadilloEnv): {
    data: JsonObject;
    encoded: string;
};
export declare function validateFunctionData(value: unknown, env?: ArmadilloEnv): {
    data: JsonObject;
    encoded: string;
};
export declare function schemaData(definition: SchemaDefinition | undefined, collection: string, data: JsonObject, partial: boolean, env?: ArmadilloEnv): {
    data: JsonObject;
    encoded: string;
};
export declare function acceptsContentType(actual: string, accepted: string[]): boolean;
export declare function validateSchemaLinks(env: ArmadilloEnv, currentAppId: string, ownerId: string, definition: SchemaDefinition | undefined, collection: string, data: JsonObject): Promise<void>;
export declare function declaredFileLinkStatements(env: ArmadilloEnv, currentAppId: string, ownerId: string, definition: SchemaDefinition | undefined, collection: string, objectId: string, data: JsonObject): ArmadilloStatement[];
export declare function syncDeclaredFileLinks(...args: Parameters<typeof declaredFileLinkStatements>): Promise<void>;
