const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function passwordHash(password: string, salt: string, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations,
    },
    material,
    256,
  );
  return bytesToHex(bits);
}

/**
 * Compare two UTF-8 strings without leaking their content through timing.
 *
 * The loop always runs `COMPARISON_WIDTH` iterations regardless of operand
 * length, so neither the shared prefix nor the longer operand's length is
 * observable. Comparing over UTF-8 bytes (not UTF-16 code units) keeps the
 * comparison width independent of how many astral characters a caller sent.
 */
const COMPARISON_WIDTH = 64;

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  // Fold the two length differences together without branching on either value.
  let mismatch = (a.length ^ b.length) | 0;
  const width = Math.max(a.length, b.length, COMPARISON_WIDTH);
  for (let index = 0; index < width; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Constant-time comparison for secrets whose length is itself sensitive.
 *
 * Hashing both sides first pins the comparison to two fixed-width 32-byte
 * digests, so an attacker learns nothing about the configured secret's length
 * or content from response timing. Use this for any secret compared against an
 * operator-supplied value (admin keys, shared secrets, webhook secrets).
 */
export async function constantTimeEqualSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const first = new Uint8Array(a);
  const second = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) {
    mismatch |= (first[index] ?? 0) ^ (second[index] ?? 0);
  }
  return mismatch === 0;
}
