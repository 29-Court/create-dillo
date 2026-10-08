import { requireUserSession } from "./auth.js";
import { requireOperator } from "./burrow.js";
import { requireTeamPolicy } from "./teams.js";
import { HttpError } from "./http.js";
async function pageUser(request, env, appId, access) {
  if (access === "public") return null;
  if (access === "operator") {
    const { auth: auth2 } = await requireOperator(request, env, appId);
    return { id: auth2.user.id, name: auth2.user.name, email: auth2.user.email };
  }
  const auth = await requireUserSession(request, env, appId);
  if (typeof access === "object") {
    await requireTeamPolicy(env, appId, access.group, auth.user.id, access.roles);
  }
  return { id: auth.user.id, name: auth.user.name, email: auth.user.email };
}
async function uiRoute(request, env, appId, backend) {
  const pathname = new URL(request.url).pathname;
  const microapp = Object.values(backend.ui?.apps ?? {}).find((app) => app.path === pathname);
  if (!microapp) return void 0;
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "BAD_REQUEST", "UI pages support GET and HEAD only.");
  }
  const user = await pageUser(request, env, appId, microapp.access ?? "user");
  if (microapp.requires?.includes("files") && !env.resources?.files) {
    throw new HttpError(503, "INTERNAL_ERROR", "This page needs file storage.");
  }
  const response = await microapp.render({ request: new Request(request.url, { method: request.method }), user });
  if (!(response instanceof Response)) {
    throw new HttpError(500, "INTERNAL_ERROR", "UI page render must return a Response.");
  }
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
export {
  uiRoute
};
