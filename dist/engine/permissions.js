import { describeAccess } from "../access.js";
import {} from "../index.js";
import {} from "./environment.js";
import { sqlIdentifier } from "./records.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { FIELD, HttpError } from "./http.js";
function recordPolicy(table, write) {
  if (write && (table?.writes === "none" || table?.team?.writes === "none")) return { kind: "closed" };
  if (!write && table?.read === "public") return { kind: "public" };
  if (!table?.team) return { kind: "owner" };
  return {
    kind: "team",
    field: table.team.field,
    roles: write ? table.team.writeRoles : table.team.readRoles,
    ownerWrite: write && table.team.ownerWrite === true
  };
}
function previewRecordAccess(table, operation, actor) {
  const policy = recordPolicy(table, operation !== "read");
  if (policy.kind === "closed") return false;
  if (operation === "create") {
    if (!actor.authenticated) return false;
    if (policy.kind !== "team") return true;
    return actor.role !== void 0 && (policy.ownerWrite || !policy.roles || policy.roles.includes(actor.role));
  }
  if (policy.kind === "public") return true;
  if (!actor.authenticated) return false;
  if (policy.kind === "owner") return actor.ownsRecord;
  return actor.role !== void 0 && (policy.ownerWrite && actor.ownsRecord || !policy.roles || policy.roles.includes(actor.role));
}
function recordReadAudience(table, record) {
  const policy = recordPolicy(table, false);
  if (policy.kind === "public") return { kind: "public" };
  if (policy.kind === "team" && typeof record[policy.field] === "string") {
    return { kind: "team", groupId: record[policy.field], roles: [...policy.roles ?? []] };
  }
  return { kind: "owner", ownerId: record.ownerId ?? null };
}
function roleSql(roles, mark) {
  return roles && roles.length > 0 ? ` AND m.role IN (${roles.map((role) => mark(role)).join(", ")})` : "";
}
function recordAccessClause(table, appId, userId, parameters, write) {
  const policy = recordPolicy(table, write);
  if (policy.kind === "public") return "";
  if (policy.kind === "closed") return "1 = 0";
  if (!userId) return "1 = 0";
  if (policy.kind !== "team") {
    parameters.push(userId);
    return `owner_id = ?${parameters.length}`;
  }
  const mark = (value) => {
    parameters.push(value);
    return "?";
  };
  const roles = policy.roles;
  const members = (extraRoles) => `SELECT m.group_id FROM ${INTERNAL_TABLES.groupMembers} AS m WHERE m.app_id = ${mark(appId)} AND m.user_id = ${mark(userId)}${roleSql(extraRoles, mark)}`;
  const inTeam = (expression, extraRoles) => `${expression} IN (${members(extraRoles)})`;
  const access = (expression) => {
    if (policy.ownerWrite && roles?.length) {
      return `((owner_id = ${mark(userId)} AND ${inTeam(expression, void 0)}) OR ${inTeam(expression, roles)})`;
    }
    if (policy.ownerWrite) return `(owner_id = ${mark(userId)} AND ${inTeam(expression, void 0)})`;
    return inTeam(expression, roles);
  };
  if (table?.storage === "columns") return `(${access(sqlIdentifier(policy.field))})`;
  if (!FIELD.test(policy.field)) throw new HttpError(500, "INTERNAL_ERROR", "Team field is invalid.");
  return `(${access("group_id")} AND json_extract(data, '$.${policy.field}') = group_id)`;
}
async function requireTeamAccess(env, currentAppId, userId, table, data, write, ownerId) {
  const policy = recordPolicy(table, write);
  if (policy.kind === "closed") {
    const viewRule = table ? describeAccess(table, "view") : "unknown";
    const editRule = table ? describeAccess(table, "edit") : "unknown";
    throw new HttpError(
      403,
      "FORBIDDEN",
      `This table does not accept record writes (edit: ${editRule}).`,
      void 0,
      `This table's policy is view: ${viewRule}, edit: ${editRule}. The record API refuses creates, updates, and deletes for every caller. To change rows, ask the app administrator to update the table's edit policy.`
    );
  }
  if (policy.kind !== "team") return;
  const groupId = data[policy.field];
  if (typeof groupId !== "string") {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Team-scoped data needs a team reference.",
      {
        [policy.field]: "Choose a team"
      },
      `This table requires a team reference in the '${policy.field}' field. Pass the id of a team the caller belongs to.`
    );
  }
  const membership = await env.DB.prepare(
    `SELECT role FROM ${INTERNAL_TABLES.groupMembers}
      WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`
  ).bind(currentAppId, groupId, userId).first();
  if (!membership) {
    const editRule = table ? describeAccess(table, "edit") : "unknown";
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your team role does not allow this record operation.",
      void 0,
      `This table's edit policy is: ${editRule}. The caller is not a member of the referenced team. Ask a team administrator to add the caller with groups.addMember(), or request membership through the app's normal access-request flow.`
    );
  }
  const roles = policy.roles;
  const ownsRecord = policy.ownerWrite && ownerId === userId;
  const hasWriteAccess = roles ? roles.includes(membership.role) : !policy.ownerWrite;
  if (!ownsRecord && !hasWriteAccess) {
    const editRule = table ? describeAccess(table, "edit") : "unknown";
    const needed = roles ? roles.join(", ") : "record creator";
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your team role does not allow this record operation.",
      void 0,
      `This table's edit policy is: ${editRule}. The caller has role '${membership.role}', but this operation requires: ${needed}. ` + (policy.ownerWrite && ownerId !== userId ? "The caller did not create this row. " : "") + "Ask a team administrator to grant the caller one of the required roles."
    );
  }
}
export {
  previewRecordAccess,
  recordAccessClause,
  recordPolicy,
  recordReadAudience,
  requireTeamAccess,
  roleSql
};
