import { HttpError } from "../http.js";
import { type SessionAuthMethod } from "../environment.js";
import { type NormalizedField } from "../../schema.js";
export declare function normalizeEmail(value: unknown): string;
export declare function authInput(body: Record<string, unknown>, requireName: boolean): {
    email: string;
    password: string;
    name: string | null;
};
export declare function scopeAllows(scopes: readonly string[], required: string): boolean;
export declare function parseProfile(raw: string | null | undefined): Record<string, unknown>;
export declare function profileAssignments(body: Record<string, unknown>, fields: Record<string, NormalizedField>, reserved: readonly string[]): Record<string, unknown>;
export declare function readProfileAssignment(fields: Record<string, NormalizedField>, current: Record<string, unknown>, assignments: Record<string, unknown>, mode: "create" | "patch"): Record<string, unknown>;
export declare function profileConflict(error: unknown): HttpError | undefined;
export declare function sessionAuthMethod(value: unknown): SessionAuthMethod | undefined;
