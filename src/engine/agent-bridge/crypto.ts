const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(seconds: number, from = new Date()): string {
  return new Date(from.getTime() + seconds * 1_000).toISOString();
}
