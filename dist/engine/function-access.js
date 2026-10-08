import { HTTP_API_PREFIX } from "../versions.js";
import { ArmadilloFunctionError } from "../backend.js";
import { route } from "./routing.js";
function callerAccess(request, env, backend) {
  async function call(path, method = "GET", body) {
    const url = new URL(request.url);
    url.pathname = path;
    url.search = "";
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return route(new Request(url, { method, headers, ...body === void 0 ? {} : { body: JSON.stringify(body) } }), env, backend);
  }
  const segment = (value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ArmadilloFunctionError(422, "VALIDATION_ERROR", "Invalid resource name or id.");
    return encodeURIComponent(value);
  };
  const tablePath = (table, id) => `${HTTP_API_PREFIX}/tables/${segment(table)}${id ? "/" + segment(id) : ""}`;
  async function object(path, method = "GET", data) {
    const response = await call(path, method, data === void 0 ? void 0 : { data });
    return (await response.json()).object;
  }
  return {
    records: {
      get: (table, id) => object(tablePath(table, id)),
      create: (table, data) => object(tablePath(table), "POST", data),
      update: (table, id, data) => object(tablePath(table, id), "PATCH", data),
      delete: async (table, id) => {
        await call(tablePath(table, id), "DELETE");
      },
      query: async (table, query = {}) => (await (await call(`${HTTP_API_PREFIX}/query/${segment(table)}`, "POST", query)).json()).results
    },
    files: {
      get: async (id) => {
        const response = await call(`${HTTP_API_PREFIX}/files/${segment(id)}`);
        return { body: response.body, size: Number(response.headers.get("content-length") ?? 0), etag: response.headers.get("etag") ?? "" };
      },
      delete: async (id) => {
        await call(`${HTTP_API_PREFIX}/files/${segment(id)}`, "DELETE");
      }
    }
  };
}
export {
  callerAccess
};
