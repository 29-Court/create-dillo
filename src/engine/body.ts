import { HttpError } from "./http.js";

/** Enforce the limit while consuming bytes, including chunked/lying clients. */
export function boundedBody(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maximum) throw new HttpError(413, "BAD_REQUEST", "Request body exceeds the configured size limit.");
      controller.enqueue(chunk);
    },
  }));
}
