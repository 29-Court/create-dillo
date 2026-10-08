import type { ArmadilloTrustedFile, ArmadilloTrustedGroups, ArmadilloTrustedRecords } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
/**
 * Ceiling applied when a trusted file read does not ask for one. A whole-object
 * read is buffered, so the default has to be small enough to be safe in a
 * Worker isolate and large enough for documents and images.
 */
export declare const DEFAULT_TRUSTED_FILE_BYTES: number;
export declare function trustedRecords(env: ArmadilloEnv, appId: string, backend: ArmadilloBackendDefinition, actorId: () => string): ArmadilloTrustedRecords;
export declare function trustedGroups(env: ArmadilloEnv, appId: string): ArmadilloTrustedGroups;
export declare function readTrustedFile(env: ArmadilloEnv, appId: string, id: string, options?: {
    maxBytes?: number;
}): Promise<ArmadilloTrustedFile>;
