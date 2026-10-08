import type { ObjectStorage, StoredObject, StoredObjectMetadata, MultipartUpload } from "../engine/ports.js";
/** R2-compatible object facade persisted beneath one local directory. */
export declare class LocalFileStorage implements ObjectStorage {
    readonly root: string;
    private readonly objects;
    private readonly uploads;
    constructor(root: string);
    private paths;
    private readMetadata;
    private bodyPath;
    private publish;
    private openObject;
    put(key: string, body: unknown, options?: {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
    }): Promise<StoredObjectMetadata>;
    head(key: string): Promise<StoredObjectMetadata | null>;
    get(key: string): Promise<StoredObject | null>;
    delete(key: string): Promise<void>;
    createMultipartUpload(key: string, options?: {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
    }): Promise<MultipartUpload>;
    resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}
