import type { UiMicroapp } from "../ui.js";
import { burrowPage } from "../engine/burrow-page.js";
import { settingsPage } from "../engine/settings-page.js";

function redirect(path: string): Response {
  return new Response(null, { status: 302, headers: { location: path, "cache-control": "no-store" } });
}

/** Operator management page. Its privileged APIs authorize every request. */
export function burrow(options: { path?: string } = {}): UiMicroapp {
  return { path: options.path ?? "/burrow", access: "public", render: ({ request }) => burrowPage(request.method) };
}

/** Entry point to the existing bootstrap flow. */
export function firstTimeSetup(options: { path?: string; burrowPath?: string } = {}): UiMicroapp {
  return { path: options.path ?? "/setup", access: "public", render: () => redirect(options.burrowPath ?? "/burrow") };
}

/** Operator data browser, currently hosted as a Burrow section. */
export function dataBrowser(options: { path?: string; burrowPath?: string } = {}): UiMicroapp {
  return { path: options.path ?? "/data", access: "operator", render: () => redirect(`${options.burrowPath ?? "/burrow"}?section=database`) };
}

/** Visual schema policy forecast, currently hosted as a Burrow section. */
export function permissionsBuilder(options: { path?: string; burrowPath?: string } = {}): UiMicroapp {
  return { path: options.path ?? "/permissions", access: "operator", render: () => redirect(`${options.burrowPath ?? "/burrow"}?section=permissions`) };
}

/** Signed-in account settings. Photo upload requires the Files resource. */
export function userSettings(options: { path?: string; profilePhoto?: boolean } = {}): UiMicroapp {
  return {
    path: options.path ?? "/settings",
    access: "user",
    requires: options.profilePhoto ? ["files"] : [],
    render: ({ request }) => settingsPage(request.method, options.profilePhoto === true),
  };
}
