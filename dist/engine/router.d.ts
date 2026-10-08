/** Decode a URL pathname once, rejecting malformed percent escapes. */
export declare function decodeRouteSegments(pathname: string): string[];
export interface RouteMatch {
    params: Record<string, string>;
}
/** Small exact matcher used by extracted resource handlers and their tests. */
export declare function matchRoute(segments: readonly string[], pattern: readonly string[]): RouteMatch | undefined;
