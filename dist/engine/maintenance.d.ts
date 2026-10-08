import { type ArmadilloEnv } from "./environment.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
export declare function runScheduledSweep(env: ArmadilloEnv, backend?: ArmadilloBackendDefinition): Promise<void>;
