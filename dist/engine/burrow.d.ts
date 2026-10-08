import type { ArmadilloBackendDefinition } from "../backend.js";
import type { AuthContext } from "./environment.js";
import type { ArmadilloEnv } from "./environment.js";
interface Installation {
    user_id: string;
    group_id: string;
    used_at: string;
    schema_version: string | null;
}
export declare function requireOperator(request: Request, env: ArmadilloEnv, appId: string): Promise<{
    auth: AuthContext;
    row: Installation;
}>;
export declare function burrowRoute(request: Request, env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, segments: readonly string[]): Promise<Response>;
export {};
