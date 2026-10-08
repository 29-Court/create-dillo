import type { ArmadilloBackendDefinition } from './backend.js';
/** Explicit declarations, never guesses based on scanning application code. */
export declare function appCapabilities(backend?: ArmadilloBackendDefinition): Readonly<{
    files: boolean;
    realtime: boolean;
}>;
