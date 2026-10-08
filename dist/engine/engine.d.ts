import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function handleRequest(request: Request, env: ArmadilloEnv, options?: ArmadilloBackendDefinition): Promise<Response>;
