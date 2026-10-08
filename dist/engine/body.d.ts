/** Enforce the limit while consuming bytes, including chunked/lying clients. */
export declare function boundedBody(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array>;
