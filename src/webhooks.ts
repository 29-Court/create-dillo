export interface WebhookEvent<TData = Record<string, unknown>> {
  id: string;
  name: string;
  appId: string;
  data: TData;
  actorId?: string;
  timestamp: string;
}

export interface WebhookRetryOptions {
  attempts?: number;
  backoff?: "fixed" | "exponential";
  initialDelayMs?: number;
}

export interface WebhookDefinition {
  url: string;
  /** Prefer secret('WEBHOOK_SIGNING_KEY') to keep values out of source code. */
  secret: string | ArmadilloSecret<string, true>;
  events: readonly string[];
  retry?: WebhookRetryOptions;
  transform?(event: WebhookEvent): unknown | Promise<unknown>;
}

export interface WebhookJob {
  webhookName: string;
  url: string;
  payload: string;
  signature: string;
  maxAttempts: number;
  initialDelayMs: number;
  backoff: "fixed" | "exponential";
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * The signed material for a delivery: the timestamp, then the body.
 *
 * Signing the timestamp is what makes a captured request unusable later. The
 * signature previously covered only `payload`, so anyone who observed one
 * delivery could replay that exact pair indefinitely — and with up to 20
 * attempts per job, a validly signed body could legitimately arrive 20 times.
 */
export function signatureInput(timestamp: string, payload: string): string {
  return `${timestamp}.${payload}`;
}

export async function signPayload(payload: string, secret: string): Promise<string> {
  if (!secret) throw new TypeError("Webhook secrets cannot be empty.");
  return `sha256=${await hmacSha256Hex(secret, payload)}`;
}

/**
 * Sign a delivery so a receiver can both authenticate it and bound its age.
 *
 * Receivers should reject anything outside their own skew window; this helper
 * only produces the value they compare.
 */
export async function signDelivery(
  payload: string,
  secret: string,
  timestamp: string = new Date().toISOString(),
): Promise<string> {
  if (!secret) throw new TypeError("Webhook secrets cannot be empty.");
  return `sha256=${await hmacSha256Hex(secret, signatureInput(timestamp, payload))}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = (a.length ^ b.length) | 0;
  const width = Math.max(a.length, b.length, 64);
  for (let index = 0; index < width; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Constant-time comparison for secrets whose length is itself sensitive. */
export async function constantTimeEqualSecret(left: string, right: string): Promise<boolean> {
  return constantTimeEqual(
    await hmacSha256Hex(" armadillo-webhook-compare", left),
    await hmacSha256Hex(" armadillo-webhook-compare", right),
  );
}

export async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
  timestamp?: string,
): Promise<boolean> {
  const expected = timestamp === undefined
    ? await signPayload(payload, secret)
    : `sha256=${await hmacSha256Hex(secret, signatureInput(timestamp, payload))}`;
  return constantTimeEqual(expected, signature);
}

/** Seconds a receiver should tolerate between `X-Armadillo-Timestamp` and now. */
export const WEBHOOK_TIMESTAMP_SKEW_SECONDS = 300;

/**
 * Destinations a webhook must never reach.
 *
 * Delivery runs from the engine, so an `https://169.254.169.254/...` destination
 * is a request forgery against the deployment's own metadata service. Webhook
 * URLs are code-only today, which is what keeps this defence-in-depth rather
 * than load-bearing — but the deploy recipe's `global_fetch_strictly_public` flag
 * only covers the Cloudflare path, so the check belongs in the library.
 */
const PRIVATE_HOST_SUFFIXES = [
  ".localhost", ".internal", ".local", ".home.arpa",
  "169.254.169.254", "metadata.google.internal", "metadata.goog",
];
const PRIVATE_IPV4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateWebhookDestination(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (PRIVATE_IPV4.some((pattern) => pattern.test(host))) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix))) {
    return true;
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

export function validateWebhookDefinitions(definitions: Record<string, WebhookDefinition> | undefined): void {
  for (const [name, definition] of Object.entries(definitions ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(name)) {
      throw new TypeError(`Webhook name \`${name}\` is invalid.`);
    }
    const url = new URL(definition.url);
    // Loopback over plain HTTP stays allowed: it is the documented local
    // development target. Everything else private is refused on any protocol,
    // including loopback over HTTPS, which buys no locality and only widens the
    // set of resolvable names.
    const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localDevelopment) {
      throw new TypeError(`Webhook \`${name}\` must use HTTPS (or localhost HTTP).`);
    }
    if (!localDevelopment && isPrivateWebhookDestination(url.hostname)) {
      throw new TypeError(`Webhook \`${name}\` must not target a private, loopback, or link-local address.`);
    }
    if (typeof definition.secret === "string") {
      if (definition.secret.length < 16) throw new TypeError(`Webhook \`${name}\` needs a secret of at least 16 characters.`);
    } else if (!definition.secret || definition.secret.__armadilloSecret !== true || !definition.secret.name || (definition.secret as ArmadilloSecret).required === false) {
      throw new TypeError(`Webhook \`${name}\` needs a named, required secret.`);
    }
    if (definition.events.length === 0) throw new TypeError(`Webhook \`${name}\` needs at least one event.`);
    const attempts = definition.retry?.attempts ?? 3;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
      throw new TypeError(`Webhook \`${name}\` retry attempts must be from 1 to 20.`);
    }
    const delay = definition.retry?.initialDelayMs ?? 1_000;
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 86_400_000) throw new TypeError(`Webhook \`${name}\` retry delay must be from 1 to 86400000 milliseconds.`);
  }
}

export async function buildWebhookJobs(
  definitions: Record<string, WebhookDefinition> | undefined,
  event: WebhookEvent,
  secrets: Readonly<Record<string, unknown>> = {},
): Promise<WebhookJob[]> {
  const jobs: WebhookJob[] = [];
  for (const [webhookName, definition] of Object.entries(definitions ?? {})) {
    if (!definition.events.includes(event.name) && !definition.events.includes("*")) continue;
    const secret = typeof definition.secret === "string" ? definition.secret : secrets[definition.secret.name!];
    if (typeof secret !== "string" || secret.length < 16) throw new TypeError(`Webhook \`${webhookName}\` signing secret is missing or too short.`);
    const transformed = definition.transform ? await definition.transform(event) : event;
    let payload: string;
    try {
      const encoded = JSON.stringify(transformed);
      if (encoded === undefined) throw new Error("empty");
      payload = encoded;
    } catch {
      throw new TypeError(`Webhook \`${webhookName}\` transform must return JSON-serializable data.`);
    }
    if (encoder.encode(payload).byteLength > 256 * 1_024) {
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
      initialDelayMs: definition.retry?.initialDelayMs ?? 1_000,
      backoff: definition.retry?.backoff ?? "exponential",
    });
  }
  return jobs;
}

export function webhookRetryDelay(job: Pick<WebhookJob, "initialDelayMs" | "backoff">, attempts: number): number {
  const multiplier = job.backoff === "exponential" ? 2 ** Math.max(0, attempts - 1) : 1;
  return Math.min(job.initialDelayMs * multiplier, 24 * 60 * 60 * 1_000);
}
import type { ArmadilloSecret } from "./backend.js";
