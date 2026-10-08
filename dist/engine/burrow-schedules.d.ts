import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
/** Compact strip for the Burrow report — counts only, no error text with possible content. */
export declare function scheduleReportStrip(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition): Promise<{
    declared: number;
    paused: number;
    deadLetter: number;
    recentFailures: number;
}>;
export declare function burrowSchedulesRoute(request: Request, env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition, segments: readonly string[]): Promise<Response>;
