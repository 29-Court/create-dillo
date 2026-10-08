function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function makeId(prefix) {
  return `${prefix}_${base64Url(randomBytes(18))}`;
}
export {
  base64Url,
  makeId,
  randomBytes
};
