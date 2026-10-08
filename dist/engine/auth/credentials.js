import { HttpError } from "../http.js";
import {} from "../environment.js";
import { SchemaValidationError, assignUserProfile } from "../../schema.js";
function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}
function authInput(body, requireName) {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const fields = {};
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) fields.email = "Enter a valid email address";
  if (password.length < 10 || password.length > 1024) {
    fields.password = "Use between 10 and 1,024 characters";
  }
  if (name !== null && (name.length === 0 || name.length > 120)) {
    fields.name = "Use between 1 and 120 characters";
  }
  if (requireName && body.name !== void 0 && name === null) fields.name = "Expected a string";
  if (Object.keys(fields).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Authentication input is invalid.", fields);
  }
  return { email, password, name };
}
function scopeAllows(scopes, required) {
  return scopes.some((scope) => scope === "*" || scope === required || scope === "functions:invoke" && required.startsWith("functions:") || scope.endsWith(":*") && required.startsWith(scope.slice(0, -1)));
}
function parseProfile(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function profileAssignments(body, fields, reserved) {
  const unknown = {};
  const assignments = {};
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
function readProfileAssignment(fields, current, assignments, mode) {
  try {
    return assignUserProfile(fields, current, assignments, mode);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new HttpError(422, "VALIDATION_ERROR", error.message, error.fields);
    }
    throw error;
  }
}
function profileConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes("unique")) return void 0;
  const field = /_armadillo_users_profile_([A-Za-z][A-Za-z0-9_]*)_unique/.exec(message)?.[1];
  if (!field) return void 0;
  return new HttpError(409, "CONFLICT", `That ${field} is already in use.`);
}
function sessionAuthMethod(value) {
  if (value === "password" || value === "magic_link" || value === "oauth") return value;
  return void 0;
}
export {
  authInput,
  normalizeEmail,
  parseProfile,
  profileAssignments,
  profileConflict,
  readProfileAssignment,
  scopeAllows,
  sessionAuthMethod
};
