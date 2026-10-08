import type { StoredObjectMetadata } from "./ports.js";
import { type ArmadilloEnv } from "./environment.js";
import { type InternalFileRow } from "../backend.js";
import { type AuthContext } from "./environment.js";
import { type SchemaDefinition } from "../index.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
export interface InternalFileUploadRow {
    id: string;
    owner_id: string;
    storage_key: string;
    name: string;
    content_type: string;
    expected_size: number | null;
    kind: "presigned" | "multipart";
    r2_upload_id: string | null;
    status: "pending" | "complete" | "aborted";
    created_at: string;
    expires_at: string;
}
export declare function fileIntentInput(body: Record<string, unknown>, env: ArmadilloEnv): {
    name: string;
    contentType: string;
    size: number | null;
};
export declare function findFileUpload(env: ArmadilloEnv, currentAppId: string, id: string, ownerId: string): Promise<InternalFileUploadRow | null>;
export declare function persistCompletedFile(env: ArmadilloEnv, currentAppId: string, upload: InternalFileUploadRow, object: StoredObjectMetadata, backend?: ArmadilloBackendDefinition): Promise<InternalFileRow>;
export declare function createPresignedUpload(request: Request, env: ArmadilloEnv, currentAppId: string, auth: AuthContext): Promise<Response>;
export declare function completePresignedUpload(env: ArmadilloEnv, currentAppId: string, auth: AuthContext, id: string, backend?: ArmadilloBackendDefinition): Promise<Response>;
export declare function createMultipartUpload(request: Request, env: ArmadilloEnv, currentAppId: string, auth: AuthContext): Promise<Response>;
export declare function multipartUploadRoute(request: Request, env: ArmadilloEnv, currentAppId: string, auth: AuthContext, id: string, action?: string, part?: string, backend?: ArmadilloBackendDefinition): Promise<Response>;
export declare function findFile(env: ArmadilloEnv, currentAppId: string, id: string, ownerId: string): Promise<InternalFileRow | null>;
/** True when a browser may render this type as active content in its own origin. */
export declare function isActiveContentType(contentType: string): boolean;
/**
 * How a presigned download URL must present the object.
 *
 * Returning `attachment` for active content types means a leaked or shared
 * presigned URL downloads a file instead of rendering script in the bucket's
 * origin, which is the same protection the download route applies through
 * `downloadHeaders`.
 */
export declare function presignedDownloadOptions(name: string, contentType: string): {
    responseContentType: string;
    responseContentDisposition: string;
} | undefined;
/**
 * Read the leading bytes of an object and report whether they look like markup.
 *
 * Only used to decide whether a declared active content type is consistent with
 * the bytes. A caller who declares `image/png` and uploads a PNG is never
 * rejected on this path — this exists to catch the upload that would otherwise
 * become script in someone else's origin.
 */
export declare function looksLikeMarkup(stream: ReadableStream<Uint8Array>, limit?: number): Promise<boolean>;
export declare function findAccessibleFile(env: ArmadilloEnv, currentAppId: string, id: string, userId: string, definition?: SchemaDefinition): Promise<InternalFileRow | null>;
export declare function uploadName(request: Request): string;
export declare function uploadFile(request: Request, env: ArmadilloEnv, currentAppId: string, auth: AuthContext, backend?: ArmadilloBackendDefinition): Promise<Response>;
export declare function filesRoute(request: Request, env: ArmadilloEnv, currentAppId: string, id?: string, action?: string, definition?: SchemaDefinition, backend?: ArmadilloBackendDefinition): Promise<Response>;
export declare function recordFilesRoute(request: Request, env: ArmadilloEnv, currentAppId: string, collection: string, objectId: string, definition?: SchemaDefinition, fileId?: string): Promise<Response>;
