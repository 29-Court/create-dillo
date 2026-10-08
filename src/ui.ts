import { HTTP_API_PREFIX } from "./versions.js";
import { ROLE } from "./access.js";

/** A small browser page mounted explicitly by an application. */
export type UiAccess = "public" | "user" | "operator" | {
  /** Current membership in a group identified by its slug. */
  group: string;
  roles?: readonly string[];
};

export interface UiPageContext {
  /** URL and method only; authentication headers and cookies are removed. */
  request: Request;
  user: { id: string; name: string | null; email: string } | null;
}

export interface UiMicroapp {
  path: string;
  /** Defaults to a signed-in user. */
  access?: UiAccess;
  /** Resource gates checked before rendering. */
  requires?: readonly "files"[];
  render(context: UiPageContext): Response | Promise<Response>;
}

export interface ArmadilloUi {
  /** Only declared pages are mounted. Armadillo installs no UI by default. */
  apps?: Readonly<Record<string, UiMicroapp>>;
}

/** Framework routes take precedence over application pages and local static files. */
export function isReservedFrameworkPath(path: string): boolean {
  return path === HTTP_API_PREFIX || path.startsWith(`${HTTP_API_PREFIX}/`)
    || path === "/auth" || path.startsWith("/auth/")
    || path === "/armadillo" || path.startsWith("/armadillo/")
    || path === "/client.js" || path === "/health";
}
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

/** Reject ambiguous routes and permission declarations when the backend starts. */
export function validateUi(config?: ArmadilloUi): void {
  const seen = new Set<string>();
  for (const [name, app] of Object.entries(config?.apps ?? {})) {
    if (!SLUG.test(name)) throw new TypeError(`UI app name ${name} is invalid.`);
    if (!app || typeof app.render !== "function") throw new TypeError(`UI app ${name} needs a render function.`);
    const path = app.path;
    if (typeof path !== "string" || !/^\/[A-Za-z0-9_/-]+$/.test(path)
      || path === "/" || path.endsWith("/") || path.includes("//") || isReservedFrameworkPath(path)) {
      throw new TypeError(`UI path for ${name} is invalid or reserved.`);
    }
    if (seen.has(path)) throw new TypeError(`UI path ${path} is declared more than once.`);
    seen.add(path);
    const access = app.access ?? "user";
    if (access !== null && typeof access === "object") {
      if (!SLUG.test(access.group) || (access.roles !== undefined
        && (!Array.isArray(access.roles) || access.roles.length === 0 || access.roles.some(role => !ROLE.test(role))))) {
        throw new TypeError(`UI app ${name} has an invalid group access rule.`);
      }
    } else if (!["public", "user", "operator"].includes(access)) {
      throw new TypeError(`UI app ${name} has an invalid access rule.`);
    }
    if (app.requires !== undefined && (!Array.isArray(app.requires)
      || app.requires.some(requirement => requirement !== "files"))) {
      throw new TypeError(`UI app ${name} has an unknown resource requirement.`);
    }
  }
}

export function ui(config: ArmadilloUi = {}): ArmadilloUi {
  validateUi(config);
  return config;
}
