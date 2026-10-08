import { burrowPage } from "../engine/burrow-page.js";
import { settingsPage } from "../engine/settings-page.js";
function redirect(path) {
  return new Response(null, { status: 302, headers: { location: path, "cache-control": "no-store" } });
}
function burrow(options = {}) {
  return { path: options.path ?? "/burrow", access: "public", render: ({ request }) => burrowPage(request.method) };
}
function firstTimeSetup(options = {}) {
  return { path: options.path ?? "/setup", access: "public", render: () => redirect(options.burrowPath ?? "/burrow") };
}
function dataBrowser(options = {}) {
  return { path: options.path ?? "/data", access: "operator", render: () => redirect(`${options.burrowPath ?? "/burrow"}?section=database`) };
}
function permissionsBuilder(options = {}) {
  return { path: options.path ?? "/permissions", access: "operator", render: () => redirect(`${options.burrowPath ?? "/burrow"}?section=permissions`) };
}
function userSettings(options = {}) {
  return {
    path: options.path ?? "/settings",
    access: "user",
    requires: options.profilePhoto ? ["files"] : [],
    render: ({ request }) => settingsPage(request.method, options.profilePhoto === true)
  };
}
export {
  burrow,
  dataBrowser,
  firstTimeSetup,
  permissionsBuilder,
  userSettings
};
