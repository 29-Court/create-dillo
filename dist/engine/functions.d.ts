import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function functionRoute(request: Request, env: ArmadilloEnv, currentAppId: string, name: string, options: ArmadilloBackendDefinition): Promise<Response>;
