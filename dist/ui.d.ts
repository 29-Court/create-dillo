/** A small browser page mounted explicitly by an application. */
export type UiAccess = "public" | "user" | "operator" | {
    /** Current membership in a group identified by its slug. */
    group: string;
    roles?: readonly string[];
};
export interface UiPageContext {
    /** URL and method only; authentication headers and cookies are removed. */
    request: Request;
    user: {
        id: string;
        name: string | null;
        email: string;
    } | null;
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
export declare function isReservedFrameworkPath(path: string): boolean;
/** Reject ambiguous routes and permission declarations when the backend starts. */
export declare function validateUi(config?: ArmadilloUi): void;
export declare function ui(config?: ArmadilloUi): ArmadilloUi;
