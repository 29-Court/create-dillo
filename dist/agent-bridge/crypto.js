const encoder = new TextEncoder();
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function makeId(prefix) {
  return `${prefix}_${randomToken(12)}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function addSecondsIso(seconds, from = /* @__PURE__ */ new Date()) {
  return new Date(from.getTime() + seconds * 1e3).toISOString();
}
export {
  addSecondsIso,
  bytesToBase64Url,
  makeId,
  nowIso,
  randomToken,
  sha256Hex
};
