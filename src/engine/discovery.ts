import type { ArmadilloBackendDefinition, ArmadilloFunctionContract } from "./backend.js";
import type { NormalizedField } from "./schema.js";
import { HTTP_API_VERSION, apiPath } from "./versions.js";

export interface FunctionDescription {
  summary?: string;
  description?: string;
  tags?: readonly string[];
  /** Omit sensitive functions from all discovery. Authorization still applies. */
  discoverable?: boolean;
}
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  description?: string;
}
export type DiscoveredAuthorization = {
  authenticated: true;
  /** Trusted team slug, or `true` when redacted for an unauthenticated caller. */
  group?: string | true;
  /** Allowed roles, or `true` when redacted for an unauthenticated caller. */
  roles?: readonly string[] | true;
};

export interface DiscoveredFunction extends FunctionDescription {
  name: string;
  method: "POST";
  path: string;
  input: JsonSchema;
  output: JsonSchema;
  authorization: DiscoveredAuthorization;
}
export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  security: Array<{ bearer: never[]; }>;
  requestBody: { required: true; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<string, { description: string; content?: { "application/json": { schema: JsonSchema } } }>;
}
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, { post: OpenApiOperation }>;
  components: { securitySchemes: {
    bearer: { type: "http", scheme: "bearer" };
  } };
}
export interface ArmadilloDiscovery {
  kind: "http-api-discovery";
  protocolServer: false;
  functions: DiscoveredFunction[];
  openapi: OpenApiDocument;
}
function fieldSchema(field: NormalizedField): JsonSchema {
  if (field.nullable) {
    const result = fieldSchema({ ...field, nullable: false });
    return { ...result, type: [result.type as string, "null"] };
  }
  if (field.type === "json") return {
    description: "Any JSON value. It is stored with the record and cannot be queried.",
    ...(field.max === undefined ? {} : { maxLength: field.max }),
    ...(field.min === undefined ? {} : { minLength: field.min }),
  };
  if (field.type === "geo") return {
    type: "object", additionalProperties: false, required: ["latitude", "longitude"],
    properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 }, altitude: { type: "number", ...(field.minAltitude === undefined ? {} : { minimum: field.minAltitude }), ...(field.maxAltitude === undefined ? {} : { maximum: field.maxAltitude }) } },
  };
  const type = field.type === "integer" ? "integer"
    : field.type === "number" ? "number"
    : field.type === "boolean" ? "boolean"
    : "string";
  return { type,
    ...(field.type === "email" ? { format: "email" } : field.format ? { format: field.format } : {}),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.min === undefined ? {} : type === "string" ? { minLength: field.min } : { minimum: field.min }),
    ...(field.max === undefined ? {} : type === "string" ? { maxLength: field.max } : { maximum: field.max }),
  };
}
function contractSchema(contract: ArmadilloFunctionContract<unknown> | undefined): JsonSchema {
  if (!contract || contract.kind === "validator") return {
    description: contract ? "Validated at runtime by an opaque validator; no JSON Schema representation is available." : "No explicit runtime contract declared.",
  };
  return { type: "object", additionalProperties: false,
    properties: Object.fromEntries(Object.entries(contract.fields).map(([name, field]) => [name, fieldSchema(field.config)])),
    required: Object.entries(contract.fields).filter(([, field]) => field.config.required && field.config.default === undefined).map(([name]) => name),
  };
}
export function discoverBackend(backend: ArmadilloBackendDefinition): ArmadilloDiscovery {
  const functions: DiscoveredFunction[] = Object.entries(backend.functions ?? {})
    .filter(([, definition]) => definition.description?.discoverable !== false)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, definition]) => ({ ...definition.description, name, method: "POST", path: apiPath(`/functions/${encodeURIComponent(name)}`),
      input: contractSchema(definition.input), output: contractSchema(definition.output),
      authorization: { authenticated: true, ...definition.authorize },
    }));
  return { kind: "http-api-discovery", protocolServer: false, functions,
    openapi: { openapi: "3.1.0", info: { title: "Armadillo functions HTTP API", version: HTTP_API_VERSION },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      paths: Object.fromEntries(functions.map((fn) => [fn.path, { post: {
        operationId: fn.name, ...(fn.summary ? { summary: fn.summary } : {}), ...(fn.description ? { description: fn.description } : {}), ...(fn.tags ? { tags: fn.tags } : {}),
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: fn.input } } } } },
        responses: { "200": { description: "Function result", content: { "application/json": { schema: { type: "object", required: ["result"], properties: { result: fn.output } } } } }, "401": { description: "Authentication required" }, "403": { description: "Authorization denied" }, "422": { description: "Invalid input" } },
      } }])),
    },
  };
}
/**
 * Strip the values of a function's authorization rule.
 *
 * `authorize.group` names a trusted team slug and `authorize.roles` names the
 * roles inside it. Structure discovery is unauthenticated by default, so
 * publishing those values hands an anonymous caller a privilege map: which
 * privileged team gates which endpoint. Keep the fact that a rule exists — that
 * is useful to a legitimate integrator — and drop the names until the caller
 * has proven an identity.
 */
export function redactAuthorization(
  authorization: DiscoveredFunction["authorization"],
): DiscoveredFunction["authorization"] {
  const result: DiscoveredFunction["authorization"] = { authenticated: true };
  if (authorization.group !== undefined) result.group = true;
  if (authorization.roles !== undefined) result.roles = true;
  return result;
}

/** Apply {@link redactAuthorization} to every function in a discovery document. */
export function redactDiscoveryAuthorization(discovery: ArmadilloDiscovery): ArmadilloDiscovery {
  return {
    ...discovery,
    functions: discovery.functions.map((fn) => ({
      ...fn,
      authorization: redactAuthorization(fn.authorization),
    })),
  };
}

export function withDiscovery<T extends ArmadilloBackendDefinition>(backend: T): T & { mcp(): ArmadilloDiscovery } {
  return Object.assign({}, backend, { mcp: () => discoverBackend(backend) });
}
