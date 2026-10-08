const encoder = new TextEncoder();
function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function hmac(key, value) {
  const bytes = key instanceof Uint8Array ? new Uint8Array(key).buffer : key;
  const imported = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}
function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
function canonicalKey(key) {
  return key.split("/").map(awsEncode).join("/");
}
async function presignR2Url(credentials, options) {
  if (!/^[a-f0-9]{32}$/i.test(credentials.accountId)) throw new TypeError("R2 account ID is invalid.");
  if (!credentials.bucket.trim()) throw new TypeError("R2 bucket is required.");
  if (!credentials.accessKeyId.trim() || !credentials.secretAccessKey) throw new TypeError("R2 API credentials are required.");
  if (!Number.isInteger(options.expiresIn) || options.expiresIn < 1 || options.expiresIn > 604800) {
    throw new TypeError("Presigned URL expiry must be from 1 second to 7 days.");
  }
  const timestamp = (options.now ?? /* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  const path = `/${awsEncode(credentials.bucket)}/${canonicalKey(options.key)}`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(options.expiresIn)
  });
  if (options.responseContentType) query.set("response-content-type", options.responseContentType);
  if (options.responseContentDisposition) {
    query.set("response-content-disposition", options.responseContentDisposition);
  }
  const signedHeaders = options.contentType ? ["content-type", "host"] : ["host"];
  query.set("X-Amz-SignedHeaders", signedHeaders.join(";"));
  query.sort();
  const canonicalHeaders = signedHeaders.map((header) => `${header}:${header === "content-type" ? options.contentType : host}
`).join("");
  const canonicalRequest = [
    options.method,
    path,
    query.toString(),
    canonicalHeaders,
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    await sha256(canonicalRequest)
  ].join("\n");
  const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  query.set("X-Amz-Signature", hex(await hmac(signingKey, stringToSign)));
  return `https://${host}${path}?${query.toString()}`;
}
export {
  presignR2Url
};
