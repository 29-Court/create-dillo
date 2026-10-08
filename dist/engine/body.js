import { HttpError } from "./http.js";
function boundedBody(body, maximum) {
  let bytes = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maximum) throw new HttpError(413, "BAD_REQUEST", "Request body exceeds the configured size limit.");
      controller.enqueue(chunk);
    }
  }));
}
export {
  boundedBody
};
