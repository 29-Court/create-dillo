import type { UiMicroapp } from "../ui.js";
/** Operator management page. Its privileged APIs authorize every request. */
export declare function burrow(options?: {
    path?: string;
}): UiMicroapp;
/** Entry point to the existing bootstrap flow. */
export declare function firstTimeSetup(options?: {
    path?: string;
    burrowPath?: string;
}): UiMicroapp;
/** Operator data browser, currently hosted as a Burrow section. */
export declare function dataBrowser(options?: {
    path?: string;
    burrowPath?: string;
}): UiMicroapp;
/** Visual schema policy forecast, currently hosted as a Burrow section. */
export declare function permissionsBuilder(options?: {
    path?: string;
    burrowPath?: string;
}): UiMicroapp;
/** Signed-in account settings. Photo upload requires the Files resource. */
export declare function userSettings(options?: {
    path?: string;
    profilePhoto?: boolean;
}): UiMicroapp;
