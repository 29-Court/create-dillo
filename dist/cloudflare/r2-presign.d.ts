export interface R2SigningCredentials {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
}
export interface PresignOptions {
    method: "GET" | "PUT" | "HEAD" | "DELETE";
    key: string;
    expiresIn: number;
    now?: Date;
    /**
     * Bind this exact `Content-Type` into the signature. S3/R2 only honour a
     * signed header, so without it a client holding a presigned PUT URL can send
     * whatever content type it likes — including `text/html` for an object the
     * application recorded as an image.
     */
    contentType?: string;
    /**
     * Response headers the object store must apply to a presigned GET. Dillo
     * serves downloads with `attachment` and `nosniff` itself, but a presigned URL
     * bypasses that code path entirely, so the safe rendering mode has to travel
     * with the URL.
     */
    responseContentType?: string;
    responseContentDisposition?: string;
}
/** Create a zero-dependency AWS SigV4 URL for Cloudflare R2's S3 endpoint. */
export declare function presignR2Url(credentials: R2SigningCredentials, options: PresignOptions): Promise<string>;
