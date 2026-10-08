import type { ArmadilloTelemetry, ArmadilloSpan } from '../backend.js';
import type { ArmadilloEnv } from './environment.js';
type Attributes = ArmadilloSpan['attributes'];
/** Request-local context works on Workers without AsyncLocalStorage or globals. */
export declare function operationEnvironment(env: ArmadilloEnv, attributes: Attributes, telemetry?: ArmadilloTelemetry): ArmadilloEnv;
/** Trace context of the nearest enclosing operation span, for joining logs to telemetry. */
export declare function currentTrace(env: ArmadilloEnv): {
    traceId: string;
    spanId: string;
} | undefined;
/**
 * The incremental Promise bridge. Effect owns span completion, including failure.
 * Explicit parents preserve context across Promise boundaries and concurrent calls.
 * No automatic retries: a Promise may already have committed a write.
 */
export declare function operation<A>(env: ArmadilloEnv, name: string, attributes: Attributes, run: (env: ArmadilloEnv) => Promise<A>): Promise<A>;
export {};
