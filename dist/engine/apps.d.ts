import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
import { type ArmadilloRegisteredApp } from "../backend.js";
import { type JsonObject } from "../backend.js";
export declare function validName(value: string, label: string): string;
/**
 * Resolve the tenant namespace for a request.
 *
 * The namespace scopes every auth query, session cookie name, and rate-limit
 * bucket, so it must never be chosen by an anonymous caller on a deployment
 * that has not opted into multi-tenancy. `x-armadillo-app-id` is honoured only
 * when the operator sets `ARMADILLO_ALLOW_CLIENT_APP_ID=1`; otherwise a
 * configured or default namespace wins and the header is ignored entirely.
 */
export declare function appId(request: Request, env: ArmadilloEnv, options?: ArmadilloBackendDefinition): string;
export interface AppOperation {
    resource: string;
    action: string;
}
export declare function clientAppId(request: Request): string | undefined;
export declare function registeredAppFor(request: Request, options: ArmadilloBackendDefinition): ArmadilloRegisteredApp | undefined;
export declare function originMatches(request: Request, allowed: string): boolean;
export declare function assertRegisteredOrigin(request: Request, registration: ArmadilloRegisteredApp): void;
export declare function appOperation(request: Request, segments: readonly string[]): AppOperation;
export declare function hasAppCapability(registration: ArmadilloRegisteredApp, operation: AppOperation): boolean;
export declare function enforceRegisteredApp(request: Request, env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition, segments: readonly string[]): Promise<ArmadilloRegisteredApp | undefined>;
export declare function registrationJson(registration: ArmadilloRegisteredApp): JsonObject;
export declare function appsRoute(request: Request, env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition, registration: ArmadilloRegisteredApp, action?: string): Promise<Response>;
