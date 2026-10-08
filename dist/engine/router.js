function decodeRouteSegments(pathname) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}
function matchRoute(segments, pattern) {
  if (segments.length !== pattern.length) return void 0;
  const params = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? "";
    const actual = segments[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return void 0;
  }
  return { params };
}
export {
  decodeRouteSegments,
  matchRoute
};
