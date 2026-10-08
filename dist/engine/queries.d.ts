import { type BindValue } from "./environment.js";
import { type ArmadilloEnv } from "./environment.js";
import { type NormalizedTable } from "../index.js";
import { type JsonPrimitive } from "../backend.js";
import { type NormalizedField } from "../index.js";
import { type QueryFilter } from "./environment.js";
import { type QueryOrder } from "./environment.js";
import { type NearConstraint } from "./environment.js";
import { type BoundingBoxConstraint } from "./environment.js";
import { type SpatialOrder } from "./environment.js";
import { type JsonObject } from "../backend.js";
import { type SchemaDefinition } from "../index.js";
export declare function queryField(field: string, parameters: BindValue[], env: ArmadilloEnv, table?: NormalizedTable): string;
export declare function queryValue(value: JsonPrimitive, field: NormalizedField | undefined, env: ArmadilloEnv): BindValue | boolean;
export declare function parseFilters(value: unknown): QueryFilter[];
export declare function parseOrder(value: unknown): QueryOrder[];
export declare function geoPoint(value: unknown, label: string): NearConstraint["center"];
export declare function requireGeoField(table: NormalizedTable | undefined, field: unknown): string;
export declare function parseNear(value: unknown, table: NormalizedTable | undefined): NearConstraint[];
export declare function parseBoundingBoxes(value: unknown, table: NormalizedTable | undefined): BoundingBoxConstraint[];
export declare function parseSpatialOrder(value: unknown, table: NormalizedTable | undefined): SpatialOrder | undefined;
export declare const INCLUDE_DEPTH_MESSAGE = "Includes go 3 deep. Need more? Pluck it out and .expand() it.";
export interface ExpandNode {
    field: string;
    expand?: ExpandNode[];
}
export declare function parseExpands(value: unknown, table: NormalizedTable | undefined, depth?: number, definition?: SchemaDefinition, collection?: string): ExpandNode[];
export declare function recordPoint(record: JsonObject, field: string): NearConstraint["center"] | undefined;
/** Max in-area candidates a spatial query will load before asking the caller to narrow. */
export declare const SPATIAL_CANDIDATE_LIMIT = 10000;
/** Bound spatial candidates by near/bbox areas. Returns false when only nearest-order (no area). */
export declare function pushSpatialAreaClauses(clauses: string[], parameters: BindValue[], near: NearConstraint[], boundingBoxes: BoundingBoxConstraint[], table: NormalizedTable | undefined, env: ArmadilloEnv): boolean;
export declare function applySpatialQuery(records: JsonObject[], near: NearConstraint[], boundingBoxes: BoundingBoxConstraint[], spatialOrder: SpatialOrder | undefined, includeDistance: string | undefined): JsonObject[];
export declare function expandedRecordMap(env: ArmadilloEnv, currentAppId: string, target: string, ids: readonly string[], definition: SchemaDefinition, requesterId: string | undefined): Promise<Map<string, JsonObject>>;
export declare function expandRecords(env: ArmadilloEnv, currentAppId: string, collection: string, records: JsonObject[], expands: ExpandNode[], definition: SchemaDefinition, requesterId: string | undefined, depth?: number): Promise<JsonObject[]>;
export declare function expandRoute(request: Request, env: ArmadilloEnv, currentAppId: string, collection: string, id: string, definition: SchemaDefinition | undefined): Promise<Response>;
export declare function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number;
export declare function queryRoute(request: Request, env: ArmadilloEnv, currentAppId: string, collection: string, definition: SchemaDefinition | undefined): Promise<Response>;
