/** Package version is injected from package.json by the build. */
export const PACKAGE_VERSION: string = typeof ARMADILLO_BUILD_VERSION === "string" ? ARMADILLO_BUILD_VERSION : "development";
/** HTTP compatibility is independent of npm releases and database history. */
export const HTTP_API_VERSION = "v1" as const;
export const HTTP_API_PREFIX = `/${HTTP_API_VERSION}` as const;
export const REALTIME_PROTOCOL = `armadillo.realtime.${HTTP_API_VERSION}` as const;
export function apiPath(path: string): string {
  return `${HTTP_API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}
