import { HTTP_API_VERSION, apiPath } from "./versions.js";
function fieldSchema(field) {
  if (field.nullable) {
    const result = fieldSchema({ ...field, nullable: false });
    return { ...result, type: [result.type, "null"] };
  }
  if (field.type === "json") return {
    description: "Any JSON value. It is stored with the record and cannot be queried.",
    ...field.max === void 0 ? {} : { maxLength: field.max },
    ...field.min === void 0 ? {} : { minLength: field.min }
  };
  if (field.type === "geo") return {
    type: "object",
    additionalProperties: false,
    required: ["latitude", "longitude"],
    properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 }, altitude: { type: "number", ...field.minAltitude === void 0 ? {} : { minimum: field.minAltitude }, ...field.maxAltitude === void 0 ? {} : { maximum: field.maxAltitude } } }
  };
  const type = field.type === "integer" ? "integer" : field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : "string";
  return {
    type,
    ...field.type === "email" ? { format: "email" } : field.format ? { format: field.format } : {},
    ...field.default === void 0 ? {} : { default: field.default },
    ...field.min === void 0 ? {} : type === "string" ? { minLength: field.min } : { minimum: field.min },
    ...field.max === void 0 ? {} : type === "string" ? { maxLength: field.max } : { maximum: field.max }
  };
}
function contractSchema(contract) {
  if (!contract || contract.kind === "validator") return {
    description: contract ? "Validated at runtime by an opaque validator; no JSON Schema representation is available." : "No explicit runtime contract declared."
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(contract.fields).map(([name, field]) => [name, fieldSchema(field.config)])),
    required: Object.entries(contract.fields).filter(([, field]) => field.config.required && field.config.default === void 0).map(([name]) => name)
  };
}
function discoverBackend(backend) {
  const functions = Object.entries(backend.functions ?? {}).filter(([, definition]) => definition.description?.discoverable !== false).sort(([a], [b]) => a.localeCompare(b)).map(([name, definition]) => ({
    ...definition.description,
    name,
    method: "POST",
    path: apiPath(`/functions/${encodeURIComponent(name)}`),
    input: contractSchema(definition.input),
    output: contractSchema(definition.output),
    authorization: { authenticated: true, ...definition.authorize }
  }));
  return {
    kind: "http-api-discovery",
    protocolServer: false,
    functions,
    openapi: {
      openapi: "3.1.0",
      info: { title: "Armadillo functions HTTP API", version: HTTP_API_VERSION },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      paths: Object.fromEntries(functions.map((fn) => [fn.path, { post: {
        operationId: fn.name,
        ...fn.summary ? { summary: fn.summary } : {},
        ...fn.description ? { description: fn.description } : {},
        ...fn.tags ? { tags: fn.tags } : {},
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: fn.input } } } } },
        responses: { "200": { description: "Function result", content: { "application/json": { schema: { type: "object", required: ["result"], properties: { result: fn.output } } } } }, "401": { description: "Authentication required" }, "403": { description: "Authorization denied" }, "422": { description: "Invalid input" } }
      } }]))
    }
  };
}
function redactAuthorization(authorization) {
  const result = { authenticated: true };
  if (authorization.group !== void 0) result.group = true;
  if (authorization.roles !== void 0) result.roles = true;
  return result;
}
function redactDiscoveryAuthorization(discovery) {
  return {
    ...discovery,
    functions: discovery.functions.map((fn) => ({
      ...fn,
      authorization: redactAuthorization(fn.authorization)
    }))
  };
}
function withDiscovery(backend) {
  return Object.assign({}, backend, { mcp: () => discoverBackend(backend) });
}
export {
  discoverBackend,
  redactAuthorization,
  redactDiscoveryAuthorization,
  withDiscovery
};
