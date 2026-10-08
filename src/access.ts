/**
 * Spelling for the one record policy the engine already enforces.
 *
 * owner-private, public read, or a single team. This file does not decide
 * access at request time. It compiles a declaration into that policy, or it
 * refuses. `src/engine/permissions.ts` remains the only enforcement.
 */

/** Role names for team access rules. Shared by schema, engine, and UI validation. */
export const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;

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
  readonly config: { readonly type: string; readonly target?: string };
}

type Leaf =
  | { kind: "owner" | "anyone" | "nobody" | "members" | "record-owner" }
  | { kind: "roles"; roles: readonly string[] };

function refuse(message: string): never {
  throw new TypeError(message);
}

function term(
  kind: AccessKind,
  extra?: { roles?: readonly string[]; of?: readonly AccessTerm[] },
): AccessTerm {
  const value: AccessTerm = {
    kind,
    ...(extra?.roles ? { roles: Object.freeze([...extra.roles]) } : {}),
    ...(extra?.of ? { of: Object.freeze([...extra.of]) } : {}),
    or(other: AccessTerm) {
      if (!other || typeof other.or !== "function") refuse("or() needs another access rule.");
      const mine = value.kind === "or" ? [...(value.of ?? [])] : [value];
      const theirs = other.kind === "or" ? [...(other.of ?? [])] : [other];
      return term("or", { of: [...mine, ...theirs] });
    },
  };
  return Object.freeze(value);
}

/** The record's owner. On a private table this is the whole policy. */
export const owner: AccessTerm = term("owner");

/** Any caller, including a signed-out one. */
export const anyone: AccessTerm = term("anyone");

/** Every current member of the table's one team. */
export const members: AccessTerm = term("members");

/** No record-API writes. Reads still follow `view`. */
export const nobody: AccessTerm = term("nobody");

/**
 * The member who created the row, and only while they still belong to the team.
 * Leaving the team drops this access. It does not survive on its own.
 */
export const recordOwner: AccessTerm = term("record-owner");

/** Current members who hold one of these team roles. */
export function roles(...names: string[]): AccessTerm {
  if (names.length === 0 || names.some((role) => !ROLE.test(role))) {
    refuse("roles() needs one or more lowercase team roles, such as owner or admin.");
  }
  return term("roles", { roles: [...new Set(names)].sort() });
}

function leaves(rule: AccessTerm, side: "view" | "edit"): Leaf[] {
  if (!rule || typeof rule.kind !== "string" || typeof rule.or !== "function") {
    refuse(`${side} needs an access rule such as owner, anyone, members, roles(), or recordOwner.`);
  }
  if (rule.kind === "or") {
    if (!rule.of || rule.of.length < 2) refuse(`${side} or() needs two access rules.`);
    return rule.of.flatMap((part) => leaves(part, side));
  }
  if (rule.kind === "roles") {
    if (!rule.roles || rule.roles.length === 0) refuse("roles() needs one or more lowercase team roles, such as owner or admin.");
    return [{ kind: "roles", roles: rule.roles }];
  }
  if (rule.kind === "owner" || rule.kind === "anyone" || rule.kind === "nobody" || rule.kind === "members" || rule.kind === "record-owner") {
    return [{ kind: rule.kind }];
  }
  refuse(`Access rule \`${rule.kind}\` is not one Dillo can prove.`);
}

interface Side {
  owner: boolean;
  anyone: boolean;
  nobody: boolean;
  members: boolean;
  recordOwner: boolean;
  roles?: string[];
}

function sideOf(rule: AccessTerm, side: "view" | "edit"): Side {
  const parts = leaves(rule, side);
  const counts = new Map<string, number>();
  const roleLists: string[][] = [];
  for (const part of parts) {
    counts.set(part.kind, (counts.get(part.kind) ?? 0) + 1);
    if (part.kind === "roles") roleLists.push([...part.roles]);
  }
  for (const [kind, count] of counts) {
    if (kind !== "roles" && count > 1) refuse(`${side} repeats ${kind === "record-owner" ? "recordOwner" : kind}. Say it once.`);
  }
  const roles = roleLists.length === 0 ? undefined : [...new Set(roleLists.flat())].sort();
  return {
    owner: counts.has("owner"),
    anyone: counts.has("anyone"),
    nobody: counts.has("nobody"),
    members: counts.has("members"),
    recordOwner: counts.has("record-owner"),
    ...(roles ? { roles } : {}),
  };
}

function teamFields(fields: Record<string, AccessField>): string[] {
  return Object.entries(fields)
    .filter(([, field]) => field.config.type === "pointer" && field.config.target === "_Team")
    .map(([name]) => name)
    .sort();
}

function usesTeam(side: Side): boolean {
  return side.members || side.recordOwner || side.roles !== undefined;
}

/**
 * Compile a view/edit declaration into the policy enforced by the engine.
 * Throws when the declaration is not exactly one proved policy.
 */
export function compilePermissions(
  fields: Record<string, AccessField>,
  policy: PermissionPolicy,
): CompiledAccess {
  if (!policy || !policy.view || !policy.edit) {
    refuse("permissions() needs both view and edit.");
  }
  const view = sideOf(policy.view, "view");
  const edit = sideOf(policy.edit, "edit");

  if (view.nobody) refuse("view cannot be nobody. A record has to be readable by someone.");
  if (view.recordOwner) {
    refuse("view cannot use recordOwner. Team reads follow current membership. Creating a row does not keep a separate read.");
  }
  if (view.anyone && (view.owner || view.members || view.roles)) {
    refuse("anyone is already the widest view. It cannot be combined with another view rule.");
  }
  if (view.owner && (view.members || view.roles)) {
    refuse(
      "Dillo cannot prove owner.or(members). Leaving the team removes access, including for the person who created the row. Use members for a team, or owner for a private table.",
    );
  }
  if (view.members && view.roles) refuse("members already includes every role. Drop members or drop roles().");
  if (!view.owner && !view.anyone && !view.members && !view.roles) {
    refuse("view needs owner, anyone, members, or roles().");
  }

  if (edit.anyone) refuse("edit cannot be anyone. Dillo does not have world-writable records.");
  if (edit.nobody && (edit.owner || edit.members || edit.recordOwner || edit.roles)) {
    refuse("nobody cannot be combined with another edit rule. Close writes with edit: nobody.");
  }
  if (edit.members && edit.roles) refuse("members already includes every role. Drop members or drop roles().");
  if (edit.members && edit.recordOwner) refuse("members already includes the member who created the row.");
  if (edit.owner && (edit.members || edit.roles || edit.recordOwner)) {
    refuse(
      "owner does not combine with team rules. On a team table, recordOwner is the member who created the row, and only while they still belong.",
    );
  }
  if (!edit.owner && !edit.nobody && !edit.members && !edit.recordOwner && !edit.roles) {
    refuse("edit needs owner, nobody, members, roles(), or recordOwner.");
  }

  const teams = teamFields(fields);
  const teamScoped = view.members || view.roles !== undefined || usesTeam(edit);
  if (teamScoped) {
    if (teams.length === 0) {
      refuse("members, roles(), and recordOwner need one relation.team() field on this table.");
    }
    if (teams.length > 1) {
      refuse(`permissions() can prove one team field. This table has ${teams.join(" and ")}.`);
    }
  }
  const field = teams[0];

  if (view.owner || view.anyone) {
    if (usesTeam(edit)) {
      refuse("This view is not team-scoped, so edit cannot use members, roles(), or recordOwner. Use edit: owner or edit: nobody.");
    }
    if (edit.nobody) return { read: view.anyone ? "public" : "owner", writes: "none" };
    if (edit.owner) return { read: view.anyone ? "public" : "owner" };
    refuse("This view only pairs with edit: owner or edit: nobody.");
  }

  if (!field) refuse("members, roles(), and recordOwner need one relation.team() field on this table.");
  if (edit.owner) {
    refuse(
      "On a team table, owner is not an edit rule the engine can prove. Use recordOwner for the member who created the row. They must still belong to the team.",
    );
  }

  const readRoles = view.roles;
  if (edit.recordOwner && readRoles) {
    refuse(
      "recordOwner is only proved when every current member can read the row. This view is limited to roles, so a creator in another role could write a row they cannot read.",
    );
  }
  if (edit.members && readRoles) {
    refuse("edit members is broader than view. A member who cannot read the row must not be able to write it.");
  }
  if (edit.roles && readRoles) {
    for (const role of edit.roles) {
      if (!readRoles.includes(role)) {
        refuse(`edit role ${role} is not allowed to view the row. A person who cannot read a row must not be able to write it.`);
      }
    }
  }

  return {
    read: "owner",
    team: {
      field,
      ...(readRoles ? { readRoles } : {}),
      ...(edit.roles ? { writeRoles: edit.roles } : {}),
      ...(edit.recordOwner ? { ownerWrite: true as const } : {}),
      ...(edit.nobody ? { writes: "none" as const } : {}),
    },
  };
}

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
  normalized: { tables: Record<string, ExplainTable> };
}

function size(bytes: number): string {
  if (bytes % (1_024 * 1_024) === 0) return `${bytes / (1_024 * 1_024)} MB`;
  if (bytes % 1_024 === 0) return `${bytes / 1_024} KB`;
  return `${bytes} bytes`;
}

function list(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

function describeField(field: ExplainField): string {
  const textual = field.type === "string" || field.type === "email" || field.type === "pointer" || field.type === "file";
  const bits: string[] = [];
  if (field.type === "pointer" && field.target === "_Team") bits.push("team");
  else if (field.type === "pointer" && field.target === "_User") bits.push("user");
  else if (field.type === "pointer") bits.push(`relation to ${field.target ?? "unknown"}`);
  else if (field.type === "string" && field.format === "date") bits.push("date");
  else if (field.type === "string" && field.format === "date-time") bits.push("date-time");
  else bits.push(field.type);
  bits.push(field.required ? "required" : "optional");
  if (field.nullable) bits.push("null allowed");
  const bound = (text: string) => field.type === "json" ? `${text} characters of JSON` : textual ? `${text} characters` : text;
  if (field.min !== undefined && field.max !== undefined) {
    bits.push(bound(`${field.min}–${field.max}`));
  } else if (field.min !== undefined) {
    bits.push(bound(`at least ${field.min}`));
  } else if (field.max !== undefined) {
    bits.push(bound(`at most ${field.max}`));
  }
  if (field.contentTypes && field.contentTypes.length > 0) bits.push(field.contentTypes.join(", "));
  if (field.maxBytes !== undefined) bits.push(`up to ${size(field.maxBytes)}`);
  if (field.default !== undefined) bits.push(`default ${JSON.stringify(field.default)}`);
  return bits.join(", ");
}

function describeView(table: ExplainTable): string {
  if (table.read === "public") return "anyone";
  if (!table.team) return "the owner";
  const who = table.team.readRoles?.length
    ? `members of ${table.team.field} with role ${list(table.team.readRoles)}`
    : `members of ${table.team.field}`;
  return who;
}

function describeEdit(table: ExplainTable): string {
  if (table.writes === "none" || table.team?.writes === "none") return "nobody";
  if (!table.team) return "the owner";
  const field = table.team.field;
  const roles = table.team.writeRoles?.length ? `a member of ${field} with role ${list(table.team.writeRoles)}` : undefined;
  const creator = table.team.ownerWrite ? `the member who created the row, while they still belong to ${field}` : undefined;
  if (creator && roles) return `${creator}, or ${roles}`;
  if (creator) return creator;
  if (roles) return roles;
  return `members of ${field}`;
}

/** One side of the access law, in the words used to declare it. */
export function describeAccess(table: ExplainTable, action: "view" | "edit"): string {
  return action === "view" ? describeView(table) : describeEdit(table);
}

/** The access law, in the same words a person uses to declare it. */
export function explainSchema(definition: ExplainableSchema): string {
  const lines: string[] = [];
  for (const [name, table] of Object.entries(definition.normalized.tables)) {
    lines.push(name);
    for (const [fieldName, field] of Object.entries(table.fields)) {
      lines.push(`  ${fieldName}: ${describeField(field)}`);
    }
    lines.push(`  view: ${describeView(table)}`);
    lines.push(`  edit: ${describeEdit(table)}`);
    lines.push(`  storage: ${table.storage}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface ExplainedTableJson {
  fields: Record<string, { description: string } & ExplainField>;
  view: string;
  edit: string;
  storage: "json" | "columns";
}

/** Structured JSON schema explanation for the HTTP introspection endpoint. */
export function explainSchemaJson(definition: ExplainableSchema): Record<string, ExplainedTableJson> {
  const result: Record<string, ExplainedTableJson> = {};
  for (const [name, table] of Object.entries(definition.normalized.tables)) {
    const fields: ExplainedTableJson["fields"] = {};
    for (const [fieldName, field] of Object.entries(table.fields)) {
      fields[fieldName] = { ...field, description: describeField(field) };
    }
    result[name] = {
      fields,
      view: describeView(table),
      edit: describeEdit(table),
      storage: table.storage,
    };
  }
  return result;
}
