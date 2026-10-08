import { DatabaseSync } from "node:sqlite";
import { type SchemaDefinition } from "../index.js";
import type { ArmadilloDatabase, ArmadilloStatement } from "../backend.js";
declare class LocalSqliteStatement implements ArmadilloStatement {
    private readonly owner;
    private readonly query;
    private readonly values;
    constructor(owner: LocalSqliteDatabase, query: string, values?: readonly unknown[]);
    bind(...values: unknown[]): LocalSqliteStatement;
    belongsTo(database: LocalSqliteDatabase): boolean;
    private normalized;
    firstSync<T>(): T | null;
    allSync<T>(): {
        results: T[];
    };
    runSync(): {
        meta: {
            changes: number;
        };
    };
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{
        results: T[];
    }>;
    run(): Promise<{
        meta: {
            changes: number;
        };
    }>;
}
export interface LocalSqliteOptions {
    appId: string;
    schema?: SchemaDefinition;
    /** Immutable application migrations applied after Armadillo's own migrations. */
    migrationFiles?: readonly string[];
    allowUnsafeSchemaChanges?: boolean;
}
/** D1-compatible database facade backed by Node's built-in SQLite driver. */
export declare class LocalSqliteDatabase implements ArmadilloDatabase {
    readonly native: DatabaseSync;
    private readonly transactionContext;
    private queue;
    private closing;
    private batchSequence;
    constructor(pathname: string, options: LocalSqliteOptions);
    prepare(query: string): LocalSqliteStatement;
    run<T>(operation: () => T | Promise<T>): Promise<T>;
    batch(statements: readonly ArmadilloStatement[]): Promise<unknown[]>;
    transaction<T>(handler: (database: ArmadilloDatabase) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
export {};
