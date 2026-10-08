function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function jsonByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}
export {
  isObject,
  jsonByteLength
};
