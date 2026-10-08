import { HttpError } from "../http.js";
import { type SessionAuthMethod } from "../environment.js";
import { type NormalizedField, SchemaValidationError, assignUserProfile } from "../../schema.js";

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

export function authInput(body: Record<string, unknown>, requireName: boolean): {
  email: string;
  password: string;
  name: string | null;
} {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const fields: Record<string, string> = {};
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) fields.email = "Enter a valid email address";
  if (password.length < 10 || password.length > 1_024) {
    fields.password = "Use between 10 and 1,024 characters";
  }
  if (name !== null && (name.length === 0 || name.length > 120)) {
    fields.name = "Use between 1 and 120 characters";
  }
  if (requireName && body.name !== undefined && name === null) fields.name = "Expected a string";
  if (Object.keys(fields).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Authentication input is invalid.", fields);
  }
  return { email, password, name };
}

export function scopeAllows(scopes: readonly string[], required: string): boolean {
  return scopes.some((scope) => scope === "*" || scope === required
    || (scope === "functions:invoke" && required.startsWith("functions:"))
    || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))));
}

export function parseProfile(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function profileAssignments(
  body: Record<string, unknown>,
  fields: Record<string, NormalizedField>,
  reserved: readonly string[],
): Record<string, unknown> {
  const unknown: Record<string, string> = {};
  const assignments: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (reserved.includes(key)) continue;
    if (!Object.hasOwn(fields, key)) unknown[key] = "Field is not in this profile";
    else assignments[key] = body[key];
  }
  if (Object.keys(unknown).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Profile input is invalid.", unknown);
  }
  return assignments;
}

export function readProfileAssignment(
  fields: Record<string, NormalizedField>,
  current: Record<string, unknown>,
  assignments: Record<string, unknown>,
  mode: "create" | "patch",
): Record<string, unknown> {
  try {
    return assignUserProfile(fields, current, assignments, mode);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new HttpError(422, "VALIDATION_ERROR", error.message, error.fields);
    }
    throw error;
  }
}

export function profileConflict(error: unknown): HttpError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes("unique")) return undefined;
  const field = /_armadillo_users_profile_([A-Za-z][A-Za-z0-9_]*)_unique/.exec(message)?.[1];
  if (!field) return undefined;
  return new HttpError(409, "CONFLICT", `That ${field} is already in use.`);
}

export function sessionAuthMethod(value: unknown): SessionAuthMethod | undefined {
  if (value === "password" || value === "magic_link" || value === "oauth") return value;
  return undefined;
}
