import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
/**
 * Dispatch due user-defined schedules. Called from the maintenance sweep after
 * cleanup and webhook delivery so a noisy schedule cannot starve those first.
 * At most one start per schedule and MAX_STARTS_PER_SWEEP per sweep.
 */
export declare function dispatchDueSchedules(env: ArmadilloEnv, backend?: ArmadilloBackendDefinition): Promise<{
    started: number;
    skipped: number;
}>;
/** Advance next_due_at into the past for tests / operator force. */
export declare function forceScheduleDue(env: ArmadilloEnv, appId: string, scheduleName: string): Promise<void>;
