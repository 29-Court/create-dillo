import { HTTP_API_PREFIX } from "./versions.js";
import { ROLE } from "./access.js";
function isReservedFrameworkPath(path) {
  return path === HTTP_API_PREFIX || path.startsWith(`${HTTP_API_PREFIX}/`) || path === "/auth" || path.startsWith("/auth/") || path === "/armadillo" || path.startsWith("/armadillo/") || path === "/client.js" || path === "/health";
}
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
function validateUi(config) {
  const seen = /* @__PURE__ */ new Set();
  for (const [name, app] of Object.entries(config?.apps ?? {})) {
    if (!SLUG.test(name)) throw new TypeError(`UI app name ${name} is invalid.`);
    if (!app || typeof app.render !== "function") throw new TypeError(`UI app ${name} needs a render function.`);
    const path = app.path;
    if (typeof path !== "string" || !/^\/[A-Za-z0-9_/-]+$/.test(path) || path === "/" || path.endsWith("/") || path.includes("//") || isReservedFrameworkPath(path)) {
      throw new TypeError(`UI path for ${name} is invalid or reserved.`);
    }
    if (seen.has(path)) throw new TypeError(`UI path ${path} is declared more than once.`);
    seen.add(path);
    const access = app.access ?? "user";
    if (access !== null && typeof access === "object") {
      if (!SLUG.test(access.group) || access.roles !== void 0 && (!Array.isArray(access.roles) || access.roles.length === 0 || access.roles.some((role) => !ROLE.test(role)))) {
        throw new TypeError(`UI app ${name} has an invalid group access rule.`);
      }
    } else if (!["public", "user", "operator"].includes(access)) {
      throw new TypeError(`UI app ${name} has an invalid access rule.`);
    }
    if (app.requires !== void 0 && (!Array.isArray(app.requires) || app.requires.some((requirement) => requirement !== "files"))) {
      throw new TypeError(`UI app ${name} has an unknown resource requirement.`);
    }
  }
}
function ui(config = {}) {
  validateUi(config);
  return config;
}
export {
  isReservedFrameworkPath,
  ui,
  validateUi
};
