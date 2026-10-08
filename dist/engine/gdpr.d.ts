import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function gdprRoute(request: Request, env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition, sub: string | undefined): Promise<Response>;
