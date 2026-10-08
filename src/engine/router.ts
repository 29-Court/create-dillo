/** Decode a URL pathname once, rejecting malformed percent escapes. */
export function decodeRouteSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export interface RouteMatch {
  params: Record<string, string>;
}

/** Small exact matcher used by extracted resource handlers and their tests. */
export function matchRoute(
  segments: readonly string[],
  pattern: readonly string[],
): RouteMatch | undefined {
  if (segments.length !== pattern.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? "";
    const actual = segments[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return undefined;
  }
  return { params };
}
