import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
/** Match configured browser pages before generic application listeners. */
export declare function uiRoute(request: Request, env: ArmadilloEnv, appId: string, backend: ArmadilloBackendDefinition): Promise<Response | undefined>;
