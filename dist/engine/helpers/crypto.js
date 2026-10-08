const encoder = new TextEncoder();
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function passwordHash(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations
    },
    material,
    256
  );
  return bytesToHex(bits);
}
const COMPARISON_WIDTH = 64;
function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length | 0;
  const width = Math.max(a.length, b.length, COMPARISON_WIDTH);
  for (let index = 0; index < width; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}
async function constantTimeEqualSecret(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const first = new Uint8Array(a);
  const second = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) {
    mismatch |= (first[index] ?? 0) ^ (second[index] ?? 0);
  }
  return mismatch === 0;
}
export {
  constantTimeEqual,
  constantTimeEqualSecret,
  passwordHash,
  sha256
};
