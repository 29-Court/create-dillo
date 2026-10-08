import { type NormalizedTable } from "../index.js";
import { type BindValue } from "./environment.js";
import { type ArmadilloEnv } from "./environment.js";
import { type JsonObject } from "../backend.js";
/** Shared policy representation for SQL reads/writes and realtime audiences. */
export type RecordPolicy = {
    kind: "public";
} | {
    kind: "owner";
} | {
    kind: "closed";
} | {
    kind: "team";
    field: string;
    roles: readonly string[] | undefined;
    ownerWrite: boolean;
};
export declare function recordPolicy(table: NormalizedTable | undefined, write: boolean): RecordPolicy;
/** A display-only prediction of the same table policy used by SQL and writes. */
export declare function previewRecordAccess(table: NormalizedTable, operation: "read" | "edit" | "create", actor: {
    authenticated: boolean;
    ownsRecord: boolean;
    role?: string;
}): boolean;
export declare function recordReadAudience(table: NormalizedTable | undefined, record: JsonObject): JsonObject;
export declare function roleSql(roles: readonly string[] | undefined, mark: (value: BindValue) => string): string;
export declare function recordAccessClause(table: NormalizedTable | undefined, appId: string, userId: string | undefined, parameters: BindValue[], write: boolean): string;
export declare function requireTeamAccess(env: ArmadilloEnv, currentAppId: string, userId: string, table: NormalizedTable | undefined, data: JsonObject, write: boolean, ownerId?: string): Promise<void>;
