import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
/** GET /v1/burrow/usage — operator-only daily rollups for this app. */
export declare function burrowUsageRoute(request: Request, env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, segments: readonly string[]): Promise<Response>;
