import type { RuntimeOptions } from '../runtime.js';
import type { EngineEnvironment } from './environment.js';
import type { EngineDatabase, ObjectStorage, RealtimeNamespace } from './ports.js';
/** One application's owned capabilities; provider handles stop at the adapter. */
export interface ArmadilloResources {
    readonly appId: string;
    readonly stage: string;
    readonly db: EngineDatabase;
    readonly files?: ObjectStorage;
    readonly realtime?: RealtimeNamespace;
    readonly mailQueue?: NonNullable<EngineEnvironment['MAIL_QUEUE']>;
}
export declare function createRuntimeEnvironment(options: RuntimeOptions): EngineEnvironment & {
    resources: ArmadilloResources;
};
