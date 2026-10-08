import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function routeSegments(pathname: string): string[];
export declare function route(request: Request, env: ArmadilloEnv, options: ArmadilloBackendDefinition): Promise<Response>;
