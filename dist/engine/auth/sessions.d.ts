import { type ArmadilloEnv, type AuthContext } from "../environment.js";
import { type ArmadilloAuthProvider } from "../../backend.js";
import { type NormalizedField, type SchemaDefinition } from "../../schema.js";
export declare const MIN_ADMINISTRATIVE_SECRET_LENGTH = 24;
export declare function assertAdministrativeSecretStrength(env: ArmadilloEnv): void;
export declare function externalAuthProvider(env: ArmadilloEnv): ArmadilloAuthProvider | undefined;
export declare function externalAuth(request: Request, env: ArmadilloEnv, currentAppId: string, requiredScope?: string): Promise<AuthContext | undefined>;
export declare function requireAuth(request: Request, env: ArmadilloEnv, currentAppId: string, requiredScope?: string): Promise<AuthContext>;
export declare function optionalAuth(request: Request, env: ArmadilloEnv, currentAppId: string, requiredScope?: string): Promise<AuthContext | undefined>;
export declare function requireUserSession(request: Request, env: ArmadilloEnv, currentAppId: string): Promise<AuthContext>;
export declare function requireAdminKey(request: Request, env: ArmadilloEnv): Promise<void>;
export declare function enforceRateLimit(request: Request, env: ArmadilloEnv, currentAppId: string, bucket: string, limit: number, windowSeconds: number, discriminator?: string): Promise<void>;
export declare function safeRedirect(request: Request, env: ArmadilloEnv, candidate: unknown): string;
export declare function configuredBootstrapSecret(env: ArmadilloEnv): string;
export declare function bootstrapSecretMatches(env: ArmadilloEnv, provided: string): Promise<boolean>;
export declare function declaredUserFields(env: ArmadilloEnv, currentAppId: string, schema?: SchemaDefinition): Promise<Record<string, NormalizedField>>;
export declare function assertOwnedProfileFiles(env: ArmadilloEnv, currentAppId: string, userId: string, fields: Record<string, NormalizedField>, assignments: Record<string, unknown>): Promise<void>;
export declare function profileJsonForCreate(env: ArmadilloEnv, currentAppId: string, body: Record<string, unknown>, reserved: readonly string[], schema?: SchemaDefinition): Promise<string | undefined>;
export declare function signUp(request: Request, env: ArmadilloEnv, currentAppId: string, schema?: SchemaDefinition): Promise<Response>;
export declare function logIn(request: Request, env: ArmadilloEnv, currentAppId: string): Promise<Response>;
export declare function changePassword(request: Request, env: ArmadilloEnv, currentAppId: string): Promise<Response>;
export declare function resetUserPassword(env: ArmadilloEnv, currentAppId: string, userId: string, newPassword: string): Promise<void>;
export declare function renameUser(env: ArmadilloEnv, currentAppId: string, userId: string, name: string): Promise<{
    name: string;
}>;
export declare function createUserForAdministration(env: ArmadilloEnv, currentAppId: string, input: {
    email: string;
    password: string;
    name?: string;
}): Promise<{
    id: string;
    email: string;
    name: string | null;
}>;
