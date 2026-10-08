const encoder = new TextEncoder();
function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
function signatureInput(timestamp, payload) {
  return `${timestamp}.${payload}`;
}
async function signPayload(payload, secret) {
  if (!secret) throw new TypeError("Webhook secrets cannot be empty.");
  return `sha256=${await hmacSha256Hex(secret, payload)}`;
}
async function signDelivery(payload, secret, timestamp = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!secret) throw new TypeError("Webhook secrets cannot be empty.");
  return `sha256=${await hmacSha256Hex(secret, signatureInput(timestamp, payload))}`;
}
function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length | 0;
  const width = Math.max(a.length, b.length, 64);
  for (let index = 0; index < width; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
async function constantTimeEqualSecret(left, right) {
  return constantTimeEqual(
    await hmacSha256Hex(" armadillo-webhook-compare", left),
    await hmacSha256Hex(" armadillo-webhook-compare", right)
  );
}
async function verifySignature(payload, signature, secret, timestamp) {
  const expected = timestamp === void 0 ? await signPayload(payload, secret) : `sha256=${await hmacSha256Hex(secret, signatureInput(timestamp, payload))}`;
  return constantTimeEqual(expected, signature);
}
const WEBHOOK_TIMESTAMP_SKEW_SECONDS = 300;
const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".internal",
  ".local",
  ".home.arpa",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog"
];
const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
];
function isPrivateWebhookDestination(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (PRIVATE_IPV4.some((pattern) => pattern.test(host))) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix))) {
    return true;
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}
function validateWebhookDefinitions(definitions) {
  for (const [name, definition] of Object.entries(definitions ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(name)) {
      throw new TypeError(`Webhook name \`${name}\` is invalid.`);
    }
    const url = new URL(definition.url);
    const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localDevelopment) {
      throw new TypeError(`Webhook \`${name}\` must use HTTPS (or localhost HTTP).`);
    }
    if (!localDevelopment && isPrivateWebhookDestination(url.hostname)) {
      throw new TypeError(`Webhook \`${name}\` must not target a private, loopback, or link-local address.`);
    }
    if (typeof definition.secret === "string") {
      if (definition.secret.length < 16) throw new TypeError(`Webhook \`${name}\` needs a secret of at least 16 characters.`);
    } else if (!definition.secret || definition.secret.__armadilloSecret !== true || !definition.secret.name || definition.secret.required === false) {
      throw new TypeError(`Webhook \`${name}\` needs a named, required secret.`);
    }
    if (definition.events.length === 0) throw new TypeError(`Webhook \`${name}\` needs at least one event.`);
    const attempts = definition.retry?.attempts ?? 3;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
      throw new TypeError(`Webhook \`${name}\` retry attempts must be from 1 to 20.`);
    }
    const delay = definition.retry?.initialDelayMs ?? 1e3;
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 864e5) throw new TypeError(`Webhook \`${name}\` retry delay must be from 1 to 86400000 milliseconds.`);
  }
}
async function buildWebhookJobs(definitions, event, secrets = {}) {
  const jobs = [];
  for (const [webhookName, definition] of Object.entries(definitions ?? {})) {
    if (!definition.events.includes(event.name) && !definition.events.includes("*")) continue;
    const secret = typeof definition.secret === "string" ? definition.secret : secrets[definition.secret.name];
    if (typeof secret !== "string" || secret.length < 16) throw new TypeError(`Webhook \`${webhookName}\` signing secret is missing or too short.`);
    const transformed = definition.transform ? await definition.transform(event) : event;
    let payload;
    try {
      const encoded = JSON.stringify(transformed);
      if (encoded === void 0) throw new Error("empty");
      payload = encoded;
    } catch {
      throw new TypeError(`Webhook \`${webhookName}\` transform must return JSON-serializable data.`);
    }
    if (encoder.encode(payload).byteLength > 256 * 1024) {
      throw new TypeError(`Webhook \`${webhookName}\` payload exceeds 256 KB.`);
    }
    jobs.push({
      webhookName,
      url: definition.url,
      payload,
      // Signed material is `timestamp.payload`, and the same timestamp is
      // emitted as `X-Armadillo-Timestamp`, so a captured delivery is only
      // usable inside a receiver's skew window.
      signature: `sha256=${await hmacSha256Hex(secret, signatureInput(event.timestamp, payload))}`,
      maxAttempts: definition.retry?.attempts ?? 3,
      initialDelayMs: definition.retry?.initialDelayMs ?? 1e3,
      backoff: definition.retry?.backoff ?? "exponential"
    });
  }
  return jobs;
}
function webhookRetryDelay(job, attempts) {
  const multiplier = job.backoff === "exponential" ? 2 ** Math.max(0, attempts - 1) : 1;
  return Math.min(job.initialDelayMs * multiplier, 24 * 60 * 60 * 1e3);
}
export {
  WEBHOOK_TIMESTAMP_SKEW_SECONDS,
  buildWebhookJobs,
  constantTimeEqual,
  constantTimeEqualSecret,
  hmacSha256Hex,
  isPrivateWebhookDestination,
  signDelivery,
  signPayload,
  signatureInput,
  validateWebhookDefinitions,
  verifySignature,
  webhookRetryDelay
};
