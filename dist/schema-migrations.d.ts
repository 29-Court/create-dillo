import type { NormalizedSchema } from "./schema.js";
export type SchemaChangeSeverity = "safe" | "requires-authorization" | "destructive";
export interface SchemaChange {
    severity: SchemaChangeSeverity;
    path: string;
    message: string;
}
export interface SchemaMigrationPlan {
    changes: SchemaChange[];
    safe: SchemaChange[];
    requiresAuthorization: SchemaChange[];
    destructive: SchemaChange[];
}
/**
 * Compare normalized application schemas independently of the active adapter.
 * JSON tables stay flexible; column tables additionally feed adapter-specific
 * DDL. Removals and reinterpretations are always explicit compatibility events.
 */
export declare function planSchemaMigration(current: NormalizedSchema | undefined, desired: NormalizedSchema): SchemaMigrationPlan;
/** The plan, in the words deploy should show a person. */
export declare function formatSchemaMigration(plan: SchemaMigrationPlan): string;
export type PhysicalSchemaDialect = "sqlite" | "postgres";
export interface PhysicalSchemaMigration {
    statements: string[];
    unsupported: string[];
}
/** Stable, readable physical table name shared by every SQL adapter. */
export declare function physicalTableName(appId: string, tableName: string): string;
/** Stable hidden columns used for a physical geographic field. */
export declare function physicalGeoColumns(fieldName: string): [string, string, string];
/**
 * Build adapter-ready DDL for schema tables that opt into physical columns.
 * Destructive rebuilds are reported, never guessed.
 */
export declare function buildPhysicalSchemaMigration(appId: string, current: NormalizedSchema | undefined, desired: NormalizedSchema, dialect: PhysicalSchemaDialect): PhysicalSchemaMigration;
