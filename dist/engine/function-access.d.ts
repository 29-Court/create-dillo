import { type ArmadilloBackendDefinition, type ArmadilloFunctionContext } from '../backend.js';
import type { EngineEnvironment } from './environment.js';
/** Reuse REST authorization, schema validation, and registered-App ceilings. */
export declare function callerAccess(request: Request, env: EngineEnvironment, backend: ArmadilloBackendDefinition): Pick<ArmadilloFunctionContext, 'records' | 'files'>;
