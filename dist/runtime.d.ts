import type { ArmadilloBackendDefinition } from "./backend.js";
import type { EngineDatabase, ObjectStorage, MailBatch, RealtimeNamespace } from "./engine/ports.js";
import type { EngineEnvironment, ArmadilloFileUrlAdapter } from "./engine/environment.js";
export type { EngineDatabase as RuntimeDatabase, ObjectStorage, StoredObject, StoredObjectMetadata, MultipartUpload, UploadedPart, RealtimeNamespace, MailBatch } from "./engine/ports.js";
export type { EngineEnvironment as RuntimeEnvironment, ArmadilloFileUrlAdapter } from "./engine/environment.js";
export type { SendMailJob, MailDelivery } from "./engine/mail.js";
export interface RuntimeOptions {
    appId: string;
    backend?: ArmadilloBackendDefinition;
    /** SQLite-compatible SQL, numbered bindings, and atomic batch semantics. */
    database: EngineDatabase;
    /** Required unless backend.files is false. */
    storage?: ObjectStorage;
    signup?: "open" | "closed";
    stage?: string;
    corsOrigin?: string;
    realtime?: RealtimeNamespace;
    fileUrls?: ArmadilloFileUrlAdapter;
    /** Provider configuration/secrets; DB, FILES and identity are owned above. */
    bindings?: Omit<Partial<EngineEnvironment>, "resources" | "DB" | "FILES" | "ARMADILLO_APP_ID" | "ARMADILLO_SIGNUP_MODE" | "ARMADILLO_STAGE" | "CORS_ORIGIN" | "ARMADILLO_REALTIME" | "ARMADILLO_FILE_URLS"> & Record<string, unknown>;
}
/**
 * Bring your own components without forking the HTTP engine. The host owns
 * migration application, scheduling, queue delivery and resource disposal.
 */
export declare function createRuntime(options: RuntimeOptions): Readonly<{
    resources: import("./runtime.js").ArmadilloResources;
    fetch: (request: Request) => Promise<Response>;
    scheduled: () => Promise<void>;
    queue: (batch: MailBatch) => Promise<void>;
}>;
export type { ArmadilloResources } from "./engine/runtime.js";
