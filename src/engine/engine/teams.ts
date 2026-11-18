import { type InternalGroupMembershipRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type InternalGroupMemberUserRow } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloGroupMembership } from "../backend.js";
import { INTERNAL_TABLES } from "../backend.js";
import { HttpError } from "./http.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
import { requireAuth } from "./auth.js";
import { json } from "./http.js";
import { requireAdminKey } from "./auth.js";
import { readJson } from "./validation.js";
import { NAME } from "./http.js";
import { makeId } from "./helpers/id.js";
import { now } from "./records.js";
import { validName } from "./apps.js";
import { normalizeEmail } from "./auth.js";
import { ROLE } from "./http.js";

export function groupJson(row: InternalGroupMembershipRow): JsonObject {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    trusted: row.trusted === 1,
    createdAt: row.created_at,
  };
}

/** Insert a non-owner membership. A row that already exists keeps its role. */
export async function grantMembership(
  env: ArmadilloEnv,
  appId: string,
  groupId: string,
  userId: string,
  role: string,
): Promise<{ role: string }> {
  validName(groupId, "Group ID");
  validName(userId, "User ID");
  if (!ROLE.test(role) || role === "owner") {
    throw new HttpError(422, "VALIDATION_ERROR", "Use a non-owner role such as admin or member.");
  }
  const group = await env.DB.prepare(
    `SELECT id FROM ${INTERNAL_TABLES.groups} WHERE app_id = ? AND id = ? LIMIT 1`,
  ).bind(appId, groupId).first();
  if (!group) throw new HttpError(404, "NOT_FOUND", "Team not found.");
  const user = await env.DB.prepare(
    `SELECT id FROM ${INTERNAL_TABLES.users} WHERE app_id = ? AND id = ? LIMIT 1`,
  ).bind(appId, userId).first();
  if (!user) throw new HttpError(404, "NOT_FOUND", "User not found.");
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.groupMembers}
       (app_id, group_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, group_id, user_id) DO NOTHING`,
  ).bind(appId, groupId, userId, role, timestamp, timestamp).run();
  const membership = await env.DB.prepare(
    `SELECT role FROM ${INTERNAL_TABLES.groupMembers}
      WHERE app_id = ? AND group_id = ? AND user_id = ? LIMIT 1`,
  ).bind(appId, groupId, userId).first<{ role: string }>();
  if (!membership) throw new HttpError(404, "NOT_FOUND", "Team member not found.");
  return { role: membership.role };
}

export function memberJson(row: InternalGroupMemberUserRow): JsonObject {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.created_at,
  };
}

/** Ceiling on groups one user's membership set can contain. */
const MEMBERSHIP_CAP = 200;
/** Ceiling on members returned for one team in a single listing. */
const MEMBER_PAGE_CAP = 500;

export async function membershipsFor(
  env: ArmadilloEnv,
  currentAppId: string,
  userId: string,
): Promise<ArmadilloGroupMembership[]> {
  const result = await env.DB.prepare(
    `SELECT g.id, g.name, g.slug, g.trusted, m.role
       FROM ${INTERNAL_TABLES.groupMembers} AS m
       JOIN ${INTERNAL_TABLES.groups} AS g
         ON g.app_id = m.app_id AND g.id = m.group_id
      WHERE m.app_id = ?1 AND m.user_id = ?2
      ORDER BY g.name ASC
      LIMIT ?`,
  ).bind(currentAppId, userId, MEMBERSHIP_CAP).all<{
    id: string;
    name: string;
    slug: string;
    trusted: number;
    role: string;
  }>();
  return (result.results ?? []).map((row) => ({
    groupId: row.id,
    groupName: row.name,
    groupSlug: row.slug,
    role: row.role,
    trusted: row.trusted === 1,
  }));
}

export async function requireGroupMembership(
  env: ArmadilloEnv,
  currentAppId: string,
  groupId: string,
  userId: string,
  roles?: readonly string[],
): Promise<{ role: string }> {
  const membership = await env.DB.prepare(
    `SELECT role
       FROM ${INTERNAL_TABLES.groupMembers}
      WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3
      LIMIT 1`,
  ).bind(currentAppId, groupId, userId).first<{ role: string }>();
  if (!membership || (roles && !roles.includes(membership.role))) {
    throw new HttpError(403, "FORBIDDEN", "Your group role does not allow this operation.");
  }
  return membership;
}

export async function requireTeamPolicy(
  env: ArmadilloEnv,
  currentAppId: string,
  teamSlug: string,
  userId: string,
  roles?: readonly string[],
): Promise<{ id: string; role: string }> {
  const membership = await env.DB.prepare(
    `SELECT g.id, m.role
       FROM ${INTERNAL_TABLES.groups} AS g
       JOIN ${INTERNAL_TABLES.groupMembers} AS m
         ON m.app_id = g.app_id AND m.group_id = g.id
      WHERE g.app_id = ?1 AND g.slug = ?2 AND m.user_id = ?3
      LIMIT 1`,
  ).bind(currentAppId, teamSlug, userId).first<{ id: string; role: string }>();
  if (!membership || (roles && !roles.includes(membership.role))) {
    throw new HttpError(403, "FORBIDDEN", "Your team role does not allow this operation.");
  }
  return membership;
}

export async function configuredTeam(
  env: ArmadilloEnv,
  currentAppId: string,
  teamSlug: string,
): Promise<{ id: string; created_by: string }> {
  const group = await env.DB.prepare(
    `SELECT id, created_by FROM ${INTERNAL_TABLES.groups}
      WHERE app_id = ?1 AND slug = ?2 LIMIT 1`,
  ).bind(currentAppId, teamSlug).first<{ id: string; created_by: string }>();
  if (!group) {
    throw new HttpError(503, "INTERNAL_ERROR", `The configured team \`${teamSlug}\` does not exist yet.`);
  }
  return group;
}

export async function groupsRoute(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
  options: ArmadilloBackendDefinition,
  groupId?: string,
  action?: string,
  trustedCreate = false,
  memberId?: string,
): Promise<Response> {
  const auth = await requireAuth(
    request,
    env,
    currentAppId,
    request.method === "GET" ? "groups:read" : "groups:write",
  );

  if (!groupId && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT g.id, g.name, g.slug, g.trusted, g.created_at, m.role
         FROM ${INTERNAL_TABLES.groupMembers} AS m
         JOIN ${INTERNAL_TABLES.groups} AS g
           ON g.app_id = m.app_id AND g.id = m.group_id
        WHERE m.app_id = ?1 AND m.user_id = ?2
        ORDER BY g.name ASC`,
    ).bind(currentAppId, auth.user.id).all<InternalGroupMembershipRow>();
    return json({ groups: (result.results ?? []).map(groupJson) });
  }

  if (!groupId && request.method === "POST") {
    if (trustedCreate) await requireAdminKey(request, env);
    const body = await readJson(request, env);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const fields: Record<string, string> = {};
    if (!name || name.length > 120) fields.name = "Use between 1 and 120 characters";
    if (!NAME.test(slug)) fields.slug = "Use a short URL-safe identifier beginning with a letter";
    if (Object.keys(fields).length > 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Group input is invalid.", fields);
    }
    // The superadmin slug can never be created by anyone, including an
    // admin-key holder. Bootstrap inserts it under UNIQUE(app_id, slug), there is
    // no group-delete route to release it, and the whole bootstrap batch rolls
    // back on conflict — so anyone able to sign up could squat it and permanently
    // deny the owner their deployment.
    const superadminSlug = env.ARMADILLO_SUPERADMIN_GROUP?.trim() || "armadillo-superadmins";
    if (slug === superadminSlug) {
      throw new HttpError(403, "FORBIDDEN", "That group slug is reserved by the deployment.");
    }
    // A slug a privileged function is gated on may only be created by an
    // operator holding the admin key, since that is how the gate gets deployed.
    const reserved = Object.values(options.functions ?? {})
      .some((definition) => definition.authorize?.group === slug);
    if (reserved && !trustedCreate) {
      throw new HttpError(403, "FORBIDDEN", "This group slug is reserved by a privileged function.");
    }
    const id = makeId("group");
    const createdAt = now();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ${INTERNAL_TABLES.groups}
             (app_id, id, name, slug, trusted, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(currentAppId, id, name, slug, trustedCreate ? 1 : 0, auth.user.id, createdAt),
        env.DB.prepare(
          `INSERT INTO ${INTERNAL_TABLES.groupMembers}
             (app_id, group_id, user_id, role, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'owner', ?4, ?4)`,
        ).bind(currentAppId, id, auth.user.id, createdAt),
      ]);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        throw new HttpError(409, "CONFLICT", "A group already uses that slug.");
      }
      throw error;
    }
    return json({
      group: groupJson({
        id,
        name,
        slug,
        role: "owner",
        trusted: trustedCreate ? 1 : 0,
        created_at: createdAt,
      }),
    }, 201);
  }

  if (!groupId || (action !== "members" && action !== "transfer")) {
    throw new HttpError(404, "NOT_FOUND", "Route not found.");
  }
  validName(groupId, "Group ID");

  if (action === "transfer" && request.method === "POST") {
    await requireGroupMembership(env, currentAppId, groupId, auth.user.id, ["owner"]);
    const body = await readJson(request, env);
    const email = normalizeEmail(body.email);
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      throw new HttpError(422, "VALIDATION_ERROR", "Group transfer input is invalid.", {
        email: "Enter an existing team member's email",
      });
    }
    const user = await env.DB.prepare(
      `SELECT id, email, name FROM ${INTERNAL_TABLES.users}
        WHERE app_id = ?1 AND email = ?2 LIMIT 1`,
    ).bind(currentAppId, email).first<{ id: string; email: string; name: string | null }>();
    if (!user) throw new HttpError(404, "NOT_FOUND", "No user has that email address.");
    if (user.id === auth.user.id) {
      throw new HttpError(422, "VALIDATION_ERROR", "You already own this team.", {
        email: "Transfer ownership to another member",
      });
    }
    const target = await env.DB.prepare(
      `SELECT role, created_at FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`,
    ).bind(currentAppId, groupId, user.id).first<{ role: string; created_at: string }>();
    if (!target) {
      throw new HttpError(422, "VALIDATION_ERROR", "Transfer ownership to a current team member.", {
        email: "Add them to the team first",
      });
    }
    if (target.role === "owner") {
      throw new HttpError(409, "CONFLICT", "That member already holds the owner role.");
    }
    const caller = await env.DB.prepare(
      `SELECT created_at FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`,
    ).bind(currentAppId, groupId, auth.user.id).first<{ created_at: string }>();
    const timestamp = now();
    // Execution-time predicates: if a concurrent transfer already moved
    // ownership, both updates no-op inside the same atomic batch instead of
    // stranding two owners. The re-read below turns that into a 409.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.groupMembers} SET role = 'owner', updated_at = ?
          WHERE app_id = ? AND group_id = ? AND user_id = ?
            AND EXISTS (SELECT 1 FROM ${INTERNAL_TABLES.groupMembers} AS guard
              WHERE guard.app_id = ? AND guard.group_id = ?
                AND guard.user_id = ? AND guard.role = 'owner')`,
      ).bind(timestamp, currentAppId, groupId, user.id, currentAppId, groupId, auth.user.id),
      env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.groupMembers} SET role = 'admin', updated_at = ?1
          WHERE app_id = ?2 AND group_id = ?3 AND user_id = ?4 AND role = 'owner'`,
      ).bind(timestamp, currentAppId, groupId, auth.user.id),
    ]);
    const settled = await env.DB.prepare(
      `SELECT user_id, role FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ? AND group_id = ? AND (user_id = ? OR user_id = ?)`,
    ).bind(currentAppId, groupId, user.id, auth.user.id).all<{ user_id: string; role: string }>();
    const settledRoles = new Map((settled.results ?? []).map((row) => [row.user_id, row.role]));
    if (settledRoles.get(user.id) !== "owner" || settledRoles.get(auth.user.id) !== "admin") {
      throw new HttpError(409, "CONFLICT", "Team ownership changed during the transfer. Reload the members and try again.");
    }
    return json({
      member: memberJson({
        user_id: user.id,
        email: user.email,
        name: user.name,
        role: "owner",
        created_at: target.created_at,
      }),
      previousOwner: memberJson({
        user_id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        role: "admin",
        created_at: caller?.created_at ?? timestamp,
      }),
    });
  }
  if (action === "transfer") throw new HttpError(404, "NOT_FOUND", "Route not found.");

  if (memberId && request.method === "DELETE") {
    validName(memberId, "User ID");
    await requireGroupMembership(env, currentAppId, groupId, auth.user.id, ["owner", "admin"]);
    const membership = await env.DB.prepare(
      `SELECT role FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`,
    ).bind(currentAppId, groupId, memberId).first<{ role: string }>();
    if (!membership) throw new HttpError(404, "NOT_FOUND", "Team member not found.");
    if (membership.role === "owner") {
      throw new HttpError(409, "CONFLICT", "Transfer team ownership before removing the owner.");
    }
    // The owner guard belongs in the predicate. Checking it in JS first left a
    // window in which a concurrent ownership transfer could make this delete
    // remove the team's only owner, leaving it permanently unadministrable.
    const removed = await env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 AND role != 'owner'`,
    ).bind(currentAppId, groupId, memberId).run();
    if ((removed.meta.changes ?? 0) === 0) {
      throw new HttpError(409, "CONFLICT", "Transfer team ownership before removing the owner.");
    }
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    await requireGroupMembership(env, currentAppId, groupId, auth.user.id);
    const result = await env.DB.prepare(
      `SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at
         FROM ${INTERNAL_TABLES.groupMembers} AS m
         JOIN ${INTERNAL_TABLES.users} AS u
           ON u.app_id = m.app_id AND u.id = m.user_id
        WHERE m.app_id = ?1 AND m.group_id = ?2
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 u.name ASC
        LIMIT ?`,
    ).bind(currentAppId, groupId, MEMBER_PAGE_CAP + 1).all<InternalGroupMemberUserRow>();
    const members = (result.results ?? []).slice(0, MEMBER_PAGE_CAP).map(memberJson);
    return json({
      members,
      // A team with more members than one page is not an error; say so rather
      // than silently truncating a roster.
      ...((result.results ?? []).length > MEMBER_PAGE_CAP
        ? { truncated: true, limit: MEMBER_PAGE_CAP }
        : {}),
    });
  }

  if (request.method === "POST") {
    await requireGroupMembership(env, currentAppId, groupId, auth.user.id, ["owner", "admin"]);
    const body = await readJson(request, env);
    const email = normalizeEmail(body.email);
    const role = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
    const fields: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) fields.email = "Enter an existing user's email";
    if (!ROLE.test(role) || role === "owner") fields.role = "Use a non-owner role such as admin, scanner, or member";
    if (Object.keys(fields).length > 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Group member input is invalid.", fields);
    }
    const user = await env.DB.prepare(
      `SELECT id, email, name, created_at
         FROM ${INTERNAL_TABLES.users}
        WHERE app_id = ?1 AND email = ?2
        LIMIT 1`,
    ).bind(currentAppId, email).first<{
      id: string;
      email: string;
      name: string | null;
      created_at: string;
    }>();
    if (!user) throw new HttpError(404, "NOT_FOUND", "No user has that email address.");
    const existing = await env.DB.prepare(
      `SELECT role, created_at FROM ${INTERNAL_TABLES.groupMembers}
        WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`,
    ).bind(currentAppId, groupId, user.id).first<{ role: string; created_at: string }>();
    if (existing?.role === "owner") {
      throw new HttpError(409, "CONFLICT", "Transfer team ownership before changing the owner's role.");
    }
    const timestamp = now();
    // The conflict guard holds even if a transfer lands between the read
    // above and this write: retargeting the owner no-ops instead of demoting.
    const upserted = await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.groupMembers}
         (app_id, group_id, user_id, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (app_id, group_id, user_id)
       DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
       WHERE ${INTERNAL_TABLES.groupMembers}.role IS NULL OR ${INTERNAL_TABLES.groupMembers}.role != 'owner'`,
    ).bind(currentAppId, groupId, user.id, role, timestamp).run();
    if ((upserted.meta.changes ?? 0) === 0) {
      throw new HttpError(409, "CONFLICT", "Transfer team ownership before changing the owner's role.");
    }
    return json({
      member: memberJson({
        user_id: user.id,
        email: user.email,
        name: user.name,
        role,
        created_at: existing?.created_at ?? timestamp,
      }),
    });
  }

  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
