const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
function refuse(message) {
  throw new TypeError(message);
}
function term(kind, extra) {
  const value = {
    kind,
    ...extra?.roles ? { roles: Object.freeze([...extra.roles]) } : {},
    ...extra?.of ? { of: Object.freeze([...extra.of]) } : {},
    or(other) {
      if (!other || typeof other.or !== "function") refuse("or() needs another access rule.");
      const mine = value.kind === "or" ? [...value.of ?? []] : [value];
      const theirs = other.kind === "or" ? [...other.of ?? []] : [other];
      return term("or", { of: [...mine, ...theirs] });
    }
  };
  return Object.freeze(value);
}
const owner = term("owner");
const anyone = term("anyone");
const members = term("members");
const nobody = term("nobody");
const recordOwner = term("record-owner");
function roles(...names) {
  if (names.length === 0 || names.some((role) => !ROLE.test(role))) {
    refuse("roles() needs one or more lowercase team roles, such as owner or admin.");
  }
  return term("roles", { roles: [...new Set(names)].sort() });
}
function leaves(rule, side) {
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
function sideOf(rule, side) {
  const parts = leaves(rule, side);
  const counts = /* @__PURE__ */ new Map();
  const roleLists = [];
  for (const part of parts) {
    counts.set(part.kind, (counts.get(part.kind) ?? 0) + 1);
    if (part.kind === "roles") roleLists.push([...part.roles]);
  }
  for (const [kind, count] of counts) {
    if (kind !== "roles" && count > 1) refuse(`${side} repeats ${kind === "record-owner" ? "recordOwner" : kind}. Say it once.`);
  }
  const roles2 = roleLists.length === 0 ? void 0 : [...new Set(roleLists.flat())].sort();
  return {
    owner: counts.has("owner"),
    anyone: counts.has("anyone"),
    nobody: counts.has("nobody"),
    members: counts.has("members"),
    recordOwner: counts.has("record-owner"),
    ...roles2 ? { roles: roles2 } : {}
  };
}
function teamFields(fields) {
  return Object.entries(fields).filter(([, field]) => field.config.type === "pointer" && field.config.target === "_Team").map(([name]) => name).sort();
}
function usesTeam(side) {
  return side.members || side.recordOwner || side.roles !== void 0;
}
function compilePermissions(fields, policy) {
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
      "Dillo cannot prove owner.or(members). Leaving the team removes access, including for the person who created the row. Use members for a team, or owner for a private table."
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
      "owner does not combine with team rules. On a team table, recordOwner is the member who created the row, and only while they still belong."
    );
  }
  if (!edit.owner && !edit.nobody && !edit.members && !edit.recordOwner && !edit.roles) {
    refuse("edit needs owner, nobody, members, roles(), or recordOwner.");
  }
  const teams = teamFields(fields);
  const teamScoped = view.members || view.roles !== void 0 || usesTeam(edit);
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
      "On a team table, owner is not an edit rule the engine can prove. Use recordOwner for the member who created the row. They must still belong to the team."
    );
  }
  const readRoles = view.roles;
  if (edit.recordOwner && readRoles) {
    refuse(
      "recordOwner is only proved when every current member can read the row. This view is limited to roles, so a creator in another role could write a row they cannot read."
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
      ...readRoles ? { readRoles } : {},
      ...edit.roles ? { writeRoles: edit.roles } : {},
      ...edit.recordOwner ? { ownerWrite: true } : {},
      ...edit.nobody ? { writes: "none" } : {}
    }
  };
}
function size(bytes) {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}
function list(values) {
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}
function describeField(field) {
  const textual = field.type === "string" || field.type === "email" || field.type === "pointer" || field.type === "file";
  const bits = [];
  if (field.type === "pointer" && field.target === "_Team") bits.push("team");
  else if (field.type === "pointer" && field.target === "_User") bits.push("user");
  else if (field.type === "pointer") bits.push(`relation to ${field.target ?? "unknown"}`);
  else if (field.type === "string" && field.format === "date") bits.push("date");
  else if (field.type === "string" && field.format === "date-time") bits.push("date-time");
  else bits.push(field.type);
  bits.push(field.required ? "required" : "optional");
  if (field.nullable) bits.push("null allowed");
  const bound = (text) => field.type === "json" ? `${text} characters of JSON` : textual ? `${text} characters` : text;
  if (field.min !== void 0 && field.max !== void 0) {
    bits.push(bound(`${field.min}\u2013${field.max}`));
  } else if (field.min !== void 0) {
    bits.push(bound(`at least ${field.min}`));
  } else if (field.max !== void 0) {
    bits.push(bound(`at most ${field.max}`));
  }
  if (field.contentTypes && field.contentTypes.length > 0) bits.push(field.contentTypes.join(", "));
  if (field.maxBytes !== void 0) bits.push(`up to ${size(field.maxBytes)}`);
  if (field.default !== void 0) bits.push(`default ${JSON.stringify(field.default)}`);
  return bits.join(", ");
}
function describeView(table) {
  if (table.read === "public") return "anyone";
  if (!table.team) return "the owner";
  const who = table.team.readRoles?.length ? `members of ${table.team.field} with role ${list(table.team.readRoles)}` : `members of ${table.team.field}`;
  return who;
}
function describeEdit(table) {
  if (table.writes === "none" || table.team?.writes === "none") return "nobody";
  if (!table.team) return "the owner";
  const field = table.team.field;
  const roles2 = table.team.writeRoles?.length ? `a member of ${field} with role ${list(table.team.writeRoles)}` : void 0;
  const creator = table.team.ownerWrite ? `the member who created the row, while they still belong to ${field}` : void 0;
  if (creator && roles2) return `${creator}, or ${roles2}`;
  if (creator) return creator;
  if (roles2) return roles2;
  return `members of ${field}`;
}
function describeAccess(table, action) {
  return action === "view" ? describeView(table) : describeEdit(table);
}
function explainSchema(definition) {
  const lines = [];
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
  return `${lines.join("\n").trimEnd()}
`;
}
function explainSchemaJson(definition) {
  const result = {};
  for (const [name, table] of Object.entries(definition.normalized.tables)) {
    const fields = {};
    for (const [fieldName, field] of Object.entries(table.fields)) {
      fields[fieldName] = { ...field, description: describeField(field) };
    }
    result[name] = {
      fields,
      view: describeView(table),
      edit: describeEdit(table),
      storage: table.storage
    };
  }
  return result;
}
export {
  ROLE,
  anyone,
  compilePermissions,
  describeAccess,
  explainSchema,
  explainSchemaJson,
  members,
  nobody,
  owner,
  recordOwner,
  roles
};
