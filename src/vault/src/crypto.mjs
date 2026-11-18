// Dillo Vault — crypto primitives (WebCrypto AES-GCM; Workers + Node).
// VAULT-SPEC "perfect and secure": a standard AEAD cipher (AES-256-GCM),
// per-secret data keys wrapped by a master key. The master key (KEK) is
// read BY NAME ONLY from the Secrets Store binding `vault-master-kek`;
// no KEK material, DEK, token, or plaintext ever lives in a file, log,
// or return shape.
//
// Envelope shapes:
//   sealText(material, plaintext)  -> {"v":1,"iv":"…","ct":"…"}
// The KEK material is hashed (SHA-256) into the AES key, never used raw;
// a `v` the code does not know fails closed (no legacy fallback).
const te = new TextEncoder();
const td = new TextDecoder();

export function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? te.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomHex(nBytes) {
  return [...randomBytes(nBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function aesKeyFromMaterial(material) {
  // SHA-256(material) -> AES-GCM-256 key. Material is never used raw.
  const digest = await crypto.subtle.digest("SHA-256", te.encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Seal `plaintext` (string) under key `material`. The envelope JSON is the
// ONLY thing ever stored in dillo_secrets.sealed.
export async function sealText(material, plaintext) {
  const key = await aesKeyFromMaterial(material);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  return JSON.stringify({ v: 1, iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ct)) });
}

// Unseal an envelope JSON string under `material`. Throws Error("decrypt-failed")
// on unknown version, bad shape, or bad key — fail closed, never a legacy path.
export async function unsealText(material, envelopeJson) {
  let env;
  try {
    env = JSON.parse(envelopeJson);
  } catch {
    throw new Error("decrypt-failed");
  }
  if (!env || env.v !== 1 || typeof env.iv !== "string" || typeof env.ct !== "string") {
    throw new Error("decrypt-failed");
  }
  const key = await aesKeyFromMaterial(material);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(env.iv) },
      key,
      b64urlDecode(env.ct),
    );
    return td.decode(pt);
  } catch {
    throw new Error("decrypt-failed");
  }
}

// Public face of a secret value: SHA-256 prefix + last4. The fingerprint
// names the CONNECTION and stays stable across re-seals of the same value;
// it never reveals the value. last4 is the final 4 chars, masked by convention.
export async function fingerprintOf(value) {
  const full = await sha256Hex(value);
  return full.slice(0, 16);
}

export function last4Of(value) {
  return typeof value === "string" && value.length >= 4 ? value.slice(-4) : "";
}
