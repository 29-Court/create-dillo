/** Package version is injected from package.json by the build. */
export declare const PACKAGE_VERSION: string;
/** HTTP compatibility is independent of npm releases and database history. */
export declare const HTTP_API_VERSION: "v1";
export declare const HTTP_API_PREFIX: "/v1";
export declare const REALTIME_PROTOCOL: "armadillo.realtime.v1";
export declare function apiPath(path: string): string;
