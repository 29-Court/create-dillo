const PACKAGE_VERSION = true ? "1.0.0" : "development";
const HTTP_API_VERSION = "v1";
const HTTP_API_PREFIX = `/${HTTP_API_VERSION}`;
const REALTIME_PROTOCOL = `armadillo.realtime.${HTTP_API_VERSION}`;
function apiPath(path) {
  return `${HTTP_API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}
export {
  HTTP_API_PREFIX,
  HTTP_API_VERSION,
  PACKAGE_VERSION,
  REALTIME_PROTOCOL,
  apiPath
};
