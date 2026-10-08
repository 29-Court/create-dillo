import { explainSchemaJson } from "./access.js";
import type { ArmadilloBackendDefinition } from "./backend.js";
import { type ArmadilloDiscovery, type DiscoveredFunction } from "./discovery.js";
import { HTTP_API_VERSION, apiPath } from "./versions.js";
/** How structure discovery is configured on a backend. Default: on. */
export type ArmadilloDiscoveryConfig = boolean | {
    /**
     * When false, HTTP structure endpoints (`GET /v1/schema`, `GET /v1/discovery`,
     * `GET /v1/discovery/prompt`) return 404. Build-time `promptPack()` / `mcp()`
     * remain available for codegen.
     */
    structure?: boolean;
};
export declare function isStructureDiscoveryEnabled(backend: Pick<ArmadilloBackendDefinition, "discovery"> | undefined): boolean;
/** Stable REST catalog — single source for llms.txt and per-app prompt packs. */
export declare const REST_CATALOG: readonly [{
    readonly method: "POST";
    readonly path: "/v1/auth/signup";
    readonly summary: "{ email, password, name? }";
}, {
    readonly method: "POST";
    readonly path: "/v1/auth/login";
    readonly summary: "{ email, password }";
}, {
    readonly method: "POST";
    readonly path: "/v1/auth/logout";
    readonly summary: "End session";
}, {
    readonly method: "GET";
    readonly path: "/v1/auth/me";
    readonly summary: "Current user";
}, {
    readonly method: "POST";
    readonly path: "/v1/tables/:table";
    readonly summary: "create: { data: { ... } }";
}, {
    readonly method: "GET";
    readonly path: "/v1/tables/:table/:id";
    readonly summary: "read";
}, {
    readonly method: "PATCH";
    readonly path: "/v1/tables/:table/:id";
    readonly summary: "update: { data: { ... } }";
}, {
    readonly method: "DELETE";
    readonly path: "/v1/tables/:table/:id";
    readonly summary: "delete";
}, {
    readonly method: "POST";
    readonly path: "/v1/query/:table";
    readonly summary: "query: { filters?, order?, limit?, skip?, count?, expands? }";
}, {
    readonly method: "POST";
    readonly path: "/v1/files";
    readonly summary: "upload (multipart)";
}, {
    readonly method: "GET";
    readonly path: "/v1/files/:id";
    readonly summary: "download";
}, {
    readonly method: "POST";
    readonly path: "/v1/functions/:name";
    readonly summary: "call: { data: { ... } }";
}, {
    readonly method: "POST";
    readonly path: "/v1/groups";
    readonly summary: "create team";
}, {
    readonly method: "GET";
    readonly path: "/v1/groups";
    readonly summary: "list teams";
}, {
    readonly method: "POST";
    readonly path: "/v1/groups/:id/transfer";
    readonly summary: "owner hands ownership to a member";
}, {
    readonly method: "GET";
    readonly path: "/v1/events";
    readonly summary: "list events";
}, {
    readonly method: "GET";
    readonly path: "/v1/schema";
    readonly summary: "table field + permission law (structure discovery)";
}, {
    readonly method: "GET";
    readonly path: "/v1/discovery";
    readonly summary: "prompt pack JSON for LLM codegen (structure discovery)";
}, {
    readonly method: "GET";
    readonly path: "/v1/discovery/prompt";
    readonly summary: "prompt pack Markdown (structure discovery)";
}];
export declare const FIELD_TYPE_LINES: readonly ["`string()` — text. Chain `.min(n)`, `.max(n)`, `.date()`, `.datetime()`, `.email()`.", "`email()` — validated email string.", "`number()` — finite number. `integer()` for whole numbers. Chain `.min(n)`, `.max(n)`.", "`boolean()` — true/false. Chain `.default(true)`.", "`json()` — stored structured data. Not queryable, not a file.", "`file()` — uploaded file id. Chain `.accept(\"image/png\", \"image/jpeg\")`, `.maxSize(\"10 MB\")`.", "`relation(\"TableName\")` — pointer to another table's record.", "`relation.team()` — the one team pointer for permission policies.", "`relation.user()` — pointer to a user record.", "`computed.string(fn)` — virtual read-only field evaluated after load."];
export declare const PERMISSION_WORDS: readonly [{
    readonly word: "anyone";
    readonly meaning: "Every caller, including signed-out. View only.";
}, {
    readonly word: "owner";
    readonly meaning: "The person who created the row.";
}, {
    readonly word: "nobody";
    readonly meaning: "Closes record API writes. Reads follow `view`. Use trusted functions to change rows.";
}, {
    readonly word: "members";
    readonly meaning: "Every current member of the table's one team. Leaving removes access.";
}, {
    readonly word: "roles(\"owner\", \"admin\")";
    readonly meaning: "Current members holding one of these roles.";
}, {
    readonly word: "recordOwner";
    readonly meaning: "The member who created the row, while they still belong to the team.";
}];
export declare const KEY_CONSTRAINTS: readonly ["Default records are owner-private. Public reads and team policies are explicit.", "`permissions()` refuses rules the engine cannot prove.", "Effect is an internal dependency. The public API is Promise-based.", "Cloudflare-first; local Node/SQLite/filesystem for development.", "JSON storage is the first Cloudflare release scope. Column storage is local-only.", "Agents use delegated, function-scoped API keys. Authorization always applies.", "Published on npm under the `alpha` tag — `npm install create-dillo@alpha`. Do not invent a `create-dillo/microapps` import.", "`backend.mcp()` is functions-only OpenAPI metadata (`protocolServer: false`), not a full MCP server.", "Structure discovery exposes schema law + functions + REST — never secrets, env values, or raw SQL dumps.", "Golden path for humans/LLMs: One File (`examples/example-html`) → Guestbook (`examples/00-guestbook`) → curriculum (`examples/README.md`).", "Canonical backend spelling: `defineBackend` from `create-dillo/backend` (`Armadillo.backend` is the same alias)."];
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
    rest: ReadonlyArray<{
        method: string;
        path: string;
        summary: string;
    }>;
    /** How an LLM should query a live backend for structure. */
    queryInstructions: string;
    /** Copy-paste Markdown for micro-app codegen. */
    markdown: string;
}
export declare function buildPromptPack(backend: ArmadilloBackendDefinition, options?: {
    baseUrl?: string;
}): ArmadilloPromptPack;
/**
 * Build the prompt pack from an already-derived discovery document.
 *
 * The HTTP discovery routes pass a redacted document for unauthenticated
 * callers, so the Markdown rendering derives from the same redaction rather than
 * re-deriving the authorization values from the backend definition.
 *
 * @internal
 */
export declare function buildPromptPackFromDiscovery(discovery: ArmadilloDiscovery, backend: ArmadilloBackendDefinition, options?: {
    baseUrl?: string;
}): ArmadilloPromptPack;
export declare function renderPromptPackMarkdown(pack: Omit<ArmadilloPromptPack, "markdown">, options?: {
    baseUrl?: string;
}): string;
/** Framework cheat sheet sections (library-backed). Snippets are injected by scripts/generate-llms.ts. */
export declare function renderFrameworkLlmsSections(snippets: Record<string, string>): string;
/** Re-export for callers that only need the discovery path helper. */
export { apiPath };
