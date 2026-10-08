/**
 * Spelling for the one record policy the engine already enforces.
 *
 * owner-private, public read, or a single team. This file does not decide
 * access at request time. It compiles a declaration into that policy, or it
 * refuses. `src/engine/permissions.ts` remains the only enforcement.
 */
/** Role names for team access rules. Shared by schema, engine, and UI validation. */
export declare const ROLE: RegExp;
export type AccessKind = "owner" | "anyone" | "nobody" | "members" | "roles" | "record-owner" | "or";
export interface AccessTerm {
    readonly kind: AccessKind;
    readonly roles?: readonly string[];
    readonly of?: readonly AccessTerm[];
    or(other: AccessTerm): AccessTerm;
}
export interface PermissionPolicy {
    view: AccessTerm;
    edit: AccessTerm;
}
export interface CompiledAccess {
    read: "owner" | "public";
    writes?: "none";
    team?: {
        field: string;
        readRoles?: string[];
        writeRoles?: string[];
        ownerWrite?: true;
        writes?: "none";
    };
}
interface AccessField {
    readonly config: {
        readonly type: string;
        readonly target?: string;
    };
}
/** The record's owner. On a private table this is the whole policy. */
export declare const owner: AccessTerm;
/** Any caller, including a signed-out one. */
export declare const anyone: AccessTerm;
/** Every current member of the table's one team. */
export declare const members: AccessTerm;
/** No record-API writes. Reads still follow `view`. */
export declare const nobody: AccessTerm;
/**
 * The member who created the row, and only while they still belong to the team.
 * Leaving the team drops this access. It does not survive on its own.
 */
export declare const recordOwner: AccessTerm;
/** Current members who hold one of these team roles. */
export declare function roles(...names: string[]): AccessTerm;
/**
 * Compile a view/edit declaration into the policy enforced by the engine.
 * Throws when the declaration is not exactly one proved policy.
 */
export declare function compilePermissions(fields: Record<string, AccessField>, policy: PermissionPolicy): CompiledAccess;
interface ExplainField {
    type: string;
    required: boolean;
    format?: string;
    nullable?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
    target?: string;
    contentTypes?: string[];
    maxBytes?: number;
}
interface ExplainTable {
    fields: Record<string, ExplainField>;
    read: "owner" | "public";
    storage: "json" | "columns";
    writes?: "none";
    team?: {
        field: string;
        readRoles?: readonly string[];
        writeRoles?: readonly string[];
        ownerWrite?: boolean;
        writes?: "none";
    };
}
export interface ExplainableSchema {
    normalized: {
        tables: Record<string, ExplainTable>;
    };
}
/** One side of the access law, in the words used to declare it. */
export declare function describeAccess(table: ExplainTable, action: "view" | "edit"): string;
/** The access law, in the same words a person uses to declare it. */
export declare function explainSchema(definition: ExplainableSchema): string;
export interface ExplainedTableJson {
    fields: Record<string, {
        description: string;
    } & ExplainField>;
    view: string;
    edit: string;
    storage: "json" | "columns";
}
/** Structured JSON schema explanation for the HTTP introspection endpoint. */
export declare function explainSchemaJson(definition: ExplainableSchema): Record<string, ExplainedTableJson>;
export {};
