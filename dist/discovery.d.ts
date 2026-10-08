import type { ArmadilloBackendDefinition } from "./backend.js";
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
    security: Array<{
        bearer: never[];
    }>;
    requestBody: {
        required: true;
        content: {
            "application/json": {
                schema: JsonSchema;
            };
        };
    };
    responses: Record<string, {
        description: string;
        content?: {
            "application/json": {
                schema: JsonSchema;
            };
        };
    }>;
}
export interface OpenApiDocument {
    openapi: "3.1.0";
    info: {
        title: string;
        version: string;
    };
    paths: Record<string, {
        post: OpenApiOperation;
    }>;
    components: {
        securitySchemes: {
            bearer: {
                type: "http";
                scheme: "bearer";
            };
        };
    };
}
export interface ArmadilloDiscovery {
    kind: "http-api-discovery";
    protocolServer: false;
    functions: DiscoveredFunction[];
    openapi: OpenApiDocument;
}
export declare function discoverBackend(backend: ArmadilloBackendDefinition): ArmadilloDiscovery;
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
export declare function redactAuthorization(authorization: DiscoveredFunction["authorization"]): DiscoveredFunction["authorization"];
/** Apply {@link redactAuthorization} to every function in a discovery document. */
export declare function redactDiscoveryAuthorization(discovery: ArmadilloDiscovery): ArmadilloDiscovery;
export declare function withDiscovery<T extends ArmadilloBackendDefinition>(backend: T): T & {
    mcp(): ArmadilloDiscovery;
};
