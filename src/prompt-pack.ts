import { explainSchema, explainSchemaJson } from "./access.js";
import type { ArmadilloBackendDefinition } from "./backend.js";
import { discoverBackend, type ArmadilloDiscovery, type DiscoveredFunction } from "./discovery.js";
import { HTTP_API_VERSION, PACKAGE_VERSION, apiPath } from "./versions.js";

/** How structure discovery is configured on a backend. Default: on. */
export type ArmadilloDiscoveryConfig =
  | boolean
  | {
      /**
       * When false, HTTP structure endpoints (`GET /v1/schema`, `GET /v1/discovery`,
       * `GET /v1/discovery/prompt`) return 404. Build-time `promptPack()` / `mcp()`
       * remain available for codegen.
       */
      structure?: boolean;
    };

export function isStructureDiscoveryEnabled(
  backend: Pick<ArmadilloBackendDefinition, "discovery"> | undefined,
): boolean {
  const discovery = backend?.discovery;
  if (discovery === false) return false;
  if (discovery === true || discovery === undefined) return true;
  return discovery.structure !== false;
}

/** Stable REST catalog — single source for llms.txt and per-app prompt packs. */
export const REST_CATALOG = [
  { method: "POST", path: "/v1/auth/signup", summary: "{ email, password, name? }" },
  { method: "POST", path: "/v1/auth/login", summary: "{ email, password }" },
  { method: "POST", path: "/v1/auth/logout", summary: "End session" },
  { method: "GET", path: "/v1/auth/me", summary: "Current user" },
  { method: "POST", path: "/v1/tables/:table", summary: "create: { data: { ... } }" },
  { method: "GET", path: "/v1/tables/:table/:id", summary: "read" },
  { method: "PATCH", path: "/v1/tables/:table/:id", summary: "update: { data: { ... } }" },
  { method: "DELETE", path: "/v1/tables/:table/:id", summary: "delete" },
  { method: "POST", path: "/v1/query/:table", summary: "query: { filters?, order?, limit?, skip?, count?, expands? }" },
  { method: "POST", path: "/v1/files", summary: "upload (multipart)" },
  { method: "GET", path: "/v1/files/:id", summary: "download" },
  { method: "POST", path: "/v1/functions/:name", summary: "call: { data: { ... } }" },
  { method: "POST", path: "/v1/groups", summary: "create team" },
  { method: "GET", path: "/v1/groups", summary: "list teams" },
  { method: "POST", path: "/v1/groups/:id/transfer", summary: "owner hands ownership to a member" },
  { method: "GET", path: "/v1/events", summary: "list events" },
  { method: "GET", path: "/v1/schema", summary: "table field + permission law (structure discovery)" },
  { method: "GET", path: "/v1/discovery", summary: "prompt pack JSON for LLM codegen (structure discovery)" },
  { method: "GET", path: "/v1/discovery/prompt", summary: "prompt pack Markdown (structure discovery)" },
] as const;

export const FIELD_TYPE_LINES = [
  "`string()` — text. Chain `.min(n)`, `.max(n)`, `.date()`, `.datetime()`, `.email()`.",
  "`email()` — validated email string.",
  "`number()` — finite number. `integer()` for whole numbers. Chain `.min(n)`, `.max(n)`.",
  "`boolean()` — true/false. Chain `.default(true)`.",
  "`json()` — stored structured data. Not queryable, not a file.",
  "`file()` — uploaded file id. Chain `.accept(\"image/png\", \"image/jpeg\")`, `.maxSize(\"10 MB\")`.",
  "`relation(\"TableName\")` — pointer to another table's record.",
  "`relation.team()` — the one team pointer for permission policies.",
  "`relation.user()` — pointer to a user record.",
  "`computed.string(fn)` — virtual read-only field evaluated after load.",
] as const;

export const PERMISSION_WORDS = [
  { word: "anyone", meaning: "Every caller, including signed-out. View only." },
  { word: "owner", meaning: "The person who created the row." },
  { word: "nobody", meaning: "Closes record API writes. Reads follow `view`. Use trusted functions to change rows." },
  { word: "members", meaning: "Every current member of the table's one team. Leaving removes access." },
  { word: 'roles("owner", "admin")', meaning: "Current members holding one of these roles." },
  { word: "recordOwner", meaning: "The member who created the row, while they still belong to the team." },
] as const;

export const KEY_CONSTRAINTS = [
  "Default records are owner-private. Public reads and team policies are explicit.",
  "`permissions()` refuses rules the engine cannot prove.",
  "Effect is an internal dependency. The public API is Promise-based.",
  "Cloudflare-first; local Node/SQLite/filesystem for development.",
  "JSON storage is the first Cloudflare release scope. Column storage is local-only.",
  "Agents use delegated, function-scoped API keys. Authorization always applies.",
  "Published on npm under the `alpha` tag — `npm install create-dillo@alpha`. Do not invent a `create-dillo/microapps` import.",
  "`backend.mcp()` is functions-only OpenAPI metadata (`protocolServer: false`), not a full MCP server.",
  "Structure discovery exposes schema law + functions + REST — never secrets, env values, or raw SQL dumps.",
  "Golden path for humans/LLMs: One File (`examples/example-html`) → Guestbook (`examples/00-guestbook`) → curriculum (`examples/README.md`).",
  "Canonical backend spelling: `defineBackend` from `create-dillo/backend` (`Armadillo.backend` is the same alias).",
] as const;

export interface ArmadilloPromptPack {
  kind: "armadillo-prompt-pack";
  httpApiVersion: typeof HTTP_API_VERSION;
  packageVersion: string;
  structureDiscovery: boolean;
  /** Access law text from `schema.explain()`. */
  explain: string;
  /** Structured table law (same payload as `GET /v1/schema`). */
  tables: ReturnType<typeof explainSchemaJson>;
  /** Discoverable functions + OpenAPI (same as `backend.mcp()`). */
  functions: DiscoveredFunction[];
  openapi: ArmadilloDiscovery["openapi"];
  rest: ReadonlyArray<{ method: string; path: string; summary: string }>;
  /** How an LLM should query a live backend for structure. */
  queryInstructions: string;
  /** Copy-paste Markdown for micro-app codegen. */
  markdown: string;
}

function queryInstructions(baseUrl = "https://<your-backend>"): string {
  return [
    "Query a live Dillo backend for structure (when structure discovery is ON):",
    `1. GET ${baseUrl}/v1/discovery — JSON prompt pack (tables, functions, REST, usage).`,
    `2. GET ${baseUrl}/v1/discovery/prompt — same pack as Markdown (paste into an LLM).`,
    `3. GET ${baseUrl}/v1/schema — tables + field descriptions + view/edit law only.`,
    `4. Build-time (no HTTP): backend.promptPack() or backend.mcp() from defineBackend(...).`,
    "If those routes return 404 with code STRUCTURE_DISCOVERY_DISABLED, structure discovery is off — use a checked-in prompt pack or ask the app owner.",
    "Do not invent tables, permission words, or microapps APIs. Prefer equalTo/find on the typed client.",
  ].join("\n");
}

export function buildPromptPack(
  backend: ArmadilloBackendDefinition,
  options: { baseUrl?: string } = {},
): ArmadilloPromptPack {
  return buildPromptPackFromDiscovery(discoverBackend(backend), backend, options);
}

/**
 * Build the prompt pack from an already-derived discovery document.
 *
 * The HTTP discovery routes pass a redacted document for unauthenticated
 * callers, so the Markdown rendering derives from the same redaction rather than
 * re-deriving the authorization values from the backend definition.
 *
 * @internal
 */
export function buildPromptPackFromDiscovery(
  discovery: ArmadilloDiscovery,
  backend: ArmadilloBackendDefinition,
  options: { baseUrl?: string } = {},
): ArmadilloPromptPack {
  const tables = backend.schema ? explainSchemaJson(backend.schema) : {};
  const explain = backend.schema ? explainSchema(backend.schema) : "";
  const structureDiscovery = isStructureDiscoveryEnabled(backend);
  const baseUrl = options.baseUrl ?? "https://<your-backend>";
  const instructions = queryInstructions(baseUrl);
  const pack: Omit<ArmadilloPromptPack, "markdown"> = {
    kind: "armadillo-prompt-pack",
    httpApiVersion: HTTP_API_VERSION,
    packageVersion: PACKAGE_VERSION,
    structureDiscovery,
    explain,
    tables,
    functions: discovery.functions,
    openapi: discovery.openapi,
    rest: REST_CATALOG.map((row) => ({ ...row })),
    queryInstructions: instructions,
  };
  return { ...pack, markdown: renderPromptPackMarkdown(pack, { baseUrl }) };
}

export function renderPromptPackMarkdown(
  pack: Omit<ArmadilloPromptPack, "markdown">,
  options: { baseUrl?: string } = {},
): string {
  const baseUrl = options.baseUrl ?? "https://<your-backend>";
  const lines: string[] = [
    `# Dillo prompt pack`,
    ``,
    `kind: ${pack.kind}`,
    `http: ${pack.httpApiVersion}`,
    `package: ${pack.packageVersion}`,
    `structureDiscovery: ${pack.structureDiscovery}`,
    ``,
    `## Query this backend`,
    ``,
    pack.queryInstructions,
    ``,
    `## Access law (explain)`,
    ``,
    "```text",
    pack.explain.trimEnd() || "(no schema tables)",
    "```",
    ``,
    `## Tables (JSON)`,
    ``,
    "```json",
    JSON.stringify(pack.tables, null, 2),
    "```",
    ``,
    `## Functions`,
    ``,
  ];
  if (pack.functions.length === 0) {
    lines.push("(no discoverable functions)");
  } else {
    for (const fn of pack.functions) {
      lines.push(`- \`${fn.method} ${fn.path}\` — ${fn.summary ?? fn.name}`);
    }
  }
  lines.push(
    ``,
    `## REST`,
    ``,
    ...pack.rest.map((row) => `- \`${row.method} ${row.path}\` — ${row.summary}`),
    ``,
    `## Client skeleton`,
    ``,
    "```ts",
    `import { Armadillo } from "create-dillo/client";`,
    `import type backend from "./backend.ts";`,
    ``,
    `const api = Armadillo.client<typeof backend>({ url: ${JSON.stringify(baseUrl)} });`,
    `await api.auth.logIn({ email, password });`,
    `const rows = await api.tables.<Table>.query().descending("createdAt").find();`,
    "```",
    ``,
    `## Constraints`,
    ``,
    ...KEY_CONSTRAINTS.map((line) => `- ${line}`),
    ``,
  );
  return lines.join("\n");
}

/** Framework cheat sheet sections (library-backed). Snippets are injected by scripts/generate-llms.ts. */
export function renderFrameworkLlmsSections(snippets: Record<string, string>): string {
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;
  const permissionTable = [
    "| Word | Meaning |",
    "|---|---|",
    ...PERMISSION_WORDS.map((row) => `| \`${row.word}\` | ${row.meaning} |`),
  ].join("\n");

  return [
    `# Dillo — create-dillo`,
    ``,
    `> Small backend. Serious capability.`,
    ``,
    `Dillo gives a TypeScript app accounts, sessions, teams, permissions, data,`,
    `files, and server functions. Three files take you from data model to deployable`,
    `backend: schema.ts (what exists), backend.ts (what happens), armadillo.config.ts`,
    `(where it runs).`,
    ``,
    `> Generated from the library (\`npm run llms:generate\`). Snippets are real TypeScript under \`llms/snippets/\`. Do not hand-edit this file.`,
    ``,
    `## Golden path`,
    ``,
    `1. One File — \`examples/example-html\` (cookie auth, no schema yet)`,
    `2. Guestbook — \`examples/00-guestbook\` (first three-file lesson)`,
    `3. Curriculum — \`examples/README.md\` (permission words and numbered lessons)`,
    ``,
    `Package is **published on npm under the \`alpha\` tag** (\`npm install create-dillo@alpha\`). Effect is **internal**. Do not invent \`create-dillo/microapps\`.`,
    ``,
    `## Schema language`,
    ``,
    fence("ts", snippets["schema-guestbook"] ?? ""),
    ``,
    `### Field types`,
    ``,
    ...FIELD_TYPE_LINES.map((line) => `- ${line}`),
    ``,
    `Every field is required by default. Chain \`.optional()\` for optional, \`.nullable()\` for null,`,
    `\`.default(value)\` for a default value.`,
    ``,
    `### Permission words`,
    ``,
    `Use \`permissions({ view, edit })\` on a table.`,
    ``,
    permissionTable,
    ``,
    `Combine with \`.or()\`: \`roles("owner", "admin").or(recordOwner)\`.`,
    `\`owner.or(members)\` is rejected — leaving the team must remove access.`,
    `Call \`.explain()\` on your defined schema to print the access law the engine enforces.`,
    `\`npm run permission-evals\` grades HTTP cases plus compile refusals against those laws; proof lands in \`artifacts/\`.`,
    ``,
    `### Common patterns`,
    ``,
    `Private notebook: \`view: owner, edit: owner\``,
    `Public wall: \`view: anyone, edit: owner\``,
    `Shared team list: \`view: members, edit: members\` (needs \`relation.team()\`)`,
    `Organizer-only edits: \`view: members, edit: roles("owner", "admin")\``,
    `Closed writes (function-only): \`view: anyone, edit: nobody\``,
    ``,
    `### Start schemaless`,
    ``,
    `\`junkDrawer()\` (from \`create-dillo/schema\`) is a schemaless JSON table:`,
    `\`create({ content: { ... } })\`, query with \`whereJsonPath("content", "a.b", 1)\`.`,
    `Ownership and team metadata live outside \`content\`. Move selected rows into a`,
    `real table later with \`context.trusted.records.promote(source, id, target, transform)\``,
    `from a trusted function; the move refuses audience widening and stale sources.`,
    ``,
    `## Backend`,
    ``,
    fence("ts", snippets["backend-greet"] ?? ""),
    ``,
    `### Trusted functions`,
    ``,
    `Add \`authority: "trusted"\` to skip the caller's write policy. The handler still`,
    `decides who may call it. Use \`context.trusted.records\` for schema-validated writes,`,
    `\`context.trusted.db\` for raw SQL.`,
    ``,
    fence("ts", snippets["backend-trusted"] ?? ""),
    ``,
    `### Function context`,
    ``,
    `Inside a handler, \`context\` provides:`,
    `- \`context.user\` — \`{ id, email, name }\``,
    `- \`context.principal\` — \`{ type: "user"|"api_key", id, scopes }\``,
    `- \`context.groups\` — array of \`{ groupId, groupName, groupSlug, role, trusted }\``,
    `- \`context.records\` — caller-scoped CRUD (follows REST policy)`,
    `- \`context.files\` — caller-scoped file access`,
    `- \`context.trusted\` — requires \`authority: "trusted"\`: \`.records\`, \`.db\`, \`.users\`, \`.groups\``,
    `- \`context.emit(type, data, groupId)\` — emit a realtime event`,
    `- \`context.env\` — typed extension capabilities`,
    `- \`context.log(message, details)\` — structured logging`,
    ``,
    `## Client`,
    ``,
    `One client, built from a type-only backend import. It carries auth, records,`,
    `files, teams, and typed functions together, so there is no second \`api\` object.`,
    ``,
    fence("ts", snippets["client-typed"] ?? ""),
    ``,
    `Server-side callers (tests, scripts, trusted jobs) create a scoped client instead:`,
    `\`client.withAuth(token)\` fixes a bearer credential for that client's lifetime.`,
    `\`auth.signUp(...)\` returns \`{ user, token }\` only when called with \`{ mode: "token" }\`.`,
    ``,
    `Browser scripts: the backend serves \`/client.js\` (ESM) and \`/armadillo/client.js\` (classic).`,
    ``,
    `## Structure discovery (for LLMs / micro-apps)`,
    ``,
    `When structure discovery is ON (default):`,
    `- \`GET /v1/discovery\` — JSON prompt pack (tables, functions, REST, query instructions)`,
    `- \`GET /v1/discovery/prompt\` — Markdown prompt pack (copy-paste into an LLM)`,
    `- \`GET /v1/schema\` — tables + permission law`,
    `- Build-time: \`backend.promptPack()\` and \`backend.mcp()\` (functions OpenAPI only; not a protocol server)`,
    ``,
    `Turn it OFF:`,
    ``,
    "```ts",
    `export default defineBackend({`,
    `  schema,`,
    `  discovery: false, // or { structure: false }`,
    `});`,
    "```",
    ``,
    `Those HTTP routes then return 404 \`STRUCTURE_DISCOVERY_DISABLED\`. Build-time \`promptPack()\` still works for checked-in codegen.`,
    ``,
    `## REST API`,
    ``,
    `All routes under \`/${HTTP_API_VERSION}/\`. Authenticate with session cookies, or \`Authorization: Bearer <api-key>\` with a scoped API key from \`POST /v1/api-keys\`.`,
    ``,
    ...REST_CATALOG.map((row) => `- \`${row.method} ${row.path}\` — ${row.summary}`),
    ``,
    `## Deploy`,
    ``,
    fence("ts", snippets["deploy-cloudflare"] ?? ""),
    ``,
    `Local development: \`npm run dev\` (Node + SQLite + filesystem).`,
    `Cloudflare: Workers + D1 + R2. \`npm run deploy -- prod\`.`,
    ``,
    `## System fields`,
    ``,
    `Every record automatically has: \`id\`, \`ownerId\`, \`createdAt\`, \`updatedAt\`.`,
    `These are read-only and managed by the engine.`,
    ``,
    `## Key constraints`,
    ``,
    ...KEY_CONSTRAINTS.map((line) => `- ${line}`),
    ``,
  ].join("\n");
}

/** Re-export for callers that only need the discovery path helper. */
export { apiPath };
