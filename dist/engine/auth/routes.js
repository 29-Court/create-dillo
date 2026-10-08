import {} from "../environment.js";
import {} from "../../schema.js";
import { HttpError, json } from "../http.js";
import { INTERNAL_TABLES } from "../../backend.js";
import { userJson } from "../records.js";
import { clearSessionCookie, requestMagicLink, verifyMagicLink } from "../sessions.js";
import { externalAuthProvider, signUp, logIn, changePassword, requireUserSession, requireAuth, renameUser, declaredUserFields, assertOwnedProfileFiles } from "./sessions.js";
import { parseProfile, profileAssignments, readProfileAssignment, profileConflict } from "./credentials.js";
import { now } from "../records.js";
import { readJson } from "../validation.js";
import { encodeUserProfile } from "../../schema.js";
async function authRoute(request, env, currentAppId, action, schema) {
  if (externalAuthProvider(env) && action !== "me") {
    throw new HttpError(404, "NOT_FOUND", "Authentication is managed by the configured external provider.");
  }
  if (action === "signup" && request.method === "POST") {
    return signUp(request, env, currentAppId, schema);
  }
  if (action === "login" && request.method === "POST") {
    return logIn(request, env, currentAppId);
  }
  if (action === "magic-link" && request.method === "POST") {
    return requestMagicLink(request, env, currentAppId, schema);
  }
  if (action === "verify" && request.method === "POST") {
    return verifyMagicLink(request, env, currentAppId);
  }
  if (action === "password" && request.method === "POST") {
    return changePassword(request, env, currentAppId);
  }
  if (action === "me" && request.method === "GET") {
    const auth = await requireAuth(request, env, currentAppId);
    const profile = await env.DB.prepare(
      `SELECT profile_photo_id FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2`
    ).bind(currentAppId, auth.user.id).first();
    return json({ user: { ...userJson(auth.user), profilePhotoId: profile?.profile_photo_id ?? null }, principal: auth.principal });
  }
  if (action === "me" && request.method === "PATCH") {
    const auth = await requireUserSession(request, env, currentAppId);
    const body = await readJson(request, env);
    const fields = await declaredUserFields(env, currentAppId, schema);
    const assignments = profileAssignments(body, fields, ["name"]);
    const hasName = Object.hasOwn(body, "name");
    const hasProfile = Object.keys(assignments).length > 0;
    if (!hasName && !hasProfile) {
      throw new HttpError(422, "VALIDATION_ERROR", "Name must be a string.", { name: "Enter a display name" });
    }
    if (hasName && typeof body.name !== "string") {
      throw new HttpError(422, "VALIDATION_ERROR", "Name must be a string.", { name: "Enter a display name" });
    }
    if (!hasProfile) {
      const updated = await renameUser(env, currentAppId, auth.user.id, body.name);
      return json({ user: { ...userJson(auth.user), name: updated.name } });
    }
    const nextProfile = readProfileAssignment(fields, parseProfile(auth.user.profile), assignments, "patch");
    await assertOwnedProfileFiles(env, currentAppId, auth.user.id, fields, assignments);
    const profileJson = encodeUserProfile(nextProfile);
    const timestamp = now();
    let name = auth.user.name;
    try {
      if (hasName) {
        const trimmed = body.name.trim();
        if (trimmed.length < 1 || trimmed.length > 120) {
          throw new HttpError(422, "VALIDATION_ERROR", "Name input is invalid.", { name: "Use between 1 and 120 characters" });
        }
        const updated = await env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.users}
              SET name = ?1, profile = ?2, updated_at = ?3
            WHERE app_id = ?4 AND id = ?5`
        ).bind(trimmed, profileJson, timestamp, currentAppId, auth.user.id).run();
        if (!updated.meta.changes) throw new HttpError(404, "NOT_FOUND", "User not found.");
        name = trimmed;
      } else {
        const updated = await env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.users}
              SET profile = ?1, updated_at = ?2
            WHERE app_id = ?3 AND id = ?4`
        ).bind(profileJson, timestamp, currentAppId, auth.user.id).run();
        if (!updated.meta.changes) throw new HttpError(404, "NOT_FOUND", "User not found.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const conflict = profileConflict(error);
      if (conflict) throw conflict;
      throw error;
    }
    return json({
      user: userJson({ ...auth.user, name, profile: profileJson, updated_at: timestamp })
    });
  }
  if (action === "profile-photo" && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    const auth = await requireUserSession(request, env, currentAppId);
    if (!env.resources?.files) throw new HttpError(503, "INTERNAL_ERROR", "Profile photos need file storage.");
    if (request.method === "PUT") {
      const body = await readJson(request, env);
      const fileId = body.fileId;
      if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 160) {
        throw new HttpError(422, "VALIDATION_ERROR", "Choose an uploaded image.", { fileId: "Expected an owned file ID" });
      }
      const file2 = await env.DB.prepare(
        `SELECT content_type, size FROM ${INTERNAL_TABLES.files}
          WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 LIMIT 1`
      ).bind(currentAppId, fileId, auth.user.id).first();
      if (!file2) throw new HttpError(404, "NOT_FOUND", "Uploaded image not found.");
      if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file2.content_type) || file2.size > 5e6) {
        throw new HttpError(422, "VALIDATION_ERROR", "Profile photo must be JPEG, PNG, WebP, or AVIF under 5 MB.");
      }
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET profile_photo_id = ?1, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
      ).bind(fileId, now(), currentAppId, auth.user.id).run();
      return json({ profilePhotoId: fileId });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET profile_photo_id = NULL, updated_at = ?1 WHERE app_id = ?2 AND id = ?3`
      ).bind(now(), currentAppId, auth.user.id).run();
      return new Response(null, { status: 204 });
    }
    const file = await env.DB.prepare(
      `SELECT f.storage_key, f.content_type FROM ${INTERNAL_TABLES.users} AS u
         JOIN ${INTERNAL_TABLES.files} AS f
           ON f.app_id = u.app_id AND f.id = u.profile_photo_id AND f.owner_id = u.id
         WHERE u.app_id = ?1 AND u.id = ?2 LIMIT 1`
    ).bind(currentAppId, auth.user.id).first();
    if (!file) throw new HttpError(404, "NOT_FOUND", "Profile photo not found.");
    const object = await env.FILES.get(file.storage_key);
    if (!object?.body) throw new HttpError(404, "NOT_FOUND", "Stored profile photo is missing.");
    return new Response(object.body, { headers: {
      "content-type": file.content_type,
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    } });
  }
  if (action === "logout" && request.method === "POST") {
    const auth = await requireUserSession(request, env, currentAppId);
    await env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?1 AND token_hash = ?2`
    ).bind(currentAppId, auth.tokenHash).run();
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": clearSessionCookie(request, currentAppId, env) }
    });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  authRoute
};
