import type { ArmadilloAuthProvider } from "./backend.js";
export interface RequirementField {
    readonly key: string;
    readonly label: string;
    readonly type: "config" | "secret";
}
export interface SignInProvider {
    readonly __armadilloSignIn: true;
    readonly id: string;
    readonly label: string;
    readonly callbackPath: string;
    readonly scopes: string;
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly userInfoUrl: string;
    readonly profile: "oidc" | "github";
    readonly requirements: readonly RequirementField[];
}
export interface IntegrationDeclaration {
    readonly __armadilloIntegration: true;
    readonly id: string;
    readonly label: string;
    readonly requirements: readonly RequirementField[];
}
export interface RuntimeRequirementField extends RequirementField {
    readonly required: boolean;
    readonly configured: boolean;
}
export interface RuntimeRequirement {
    readonly id: string;
    readonly title: string;
    readonly kind: "authentication" | "integration";
    readonly callbackPath?: string;
    readonly fields: readonly RuntimeRequirementField[];
}
export interface SignInEndpoints {
    authorizeUrl?: string;
    tokenUrl?: string;
    userInfoUrl?: string;
}
export declare function google(options?: SignInEndpoints): SignInProvider;
export declare function github(options?: SignInEndpoints): SignInProvider;
export declare const auth: Readonly<{
    google: typeof google;
    github: typeof github;
}>;
export declare function integration(definition: {
    id: string;
    label: string;
    requirements: readonly RequirementField[];
}): IntegrationDeclaration;
export declare function resend(): IntegrationDeclaration;
export declare function customAuthProvider(value: unknown): ArmadilloAuthProvider | undefined;
export declare function signInProviders(authValue: unknown): readonly SignInProvider[];
export declare function assertRuntimeDeclarations(definition: {
    auth?: unknown;
    email?: unknown;
}): void;
export declare function declaredSecretRequirements(definition: {
    auth?: unknown;
    email?: unknown;
}): {
    name: string;
    description: string;
    required: false;
}[];
export declare function resolveRequirements(definition: {
    auth?: unknown;
    email?: unknown;
    secrets?: Readonly<Record<string, {
        __armadilloSecret?: boolean;
        name?: string;
        required?: boolean;
    }>>;
}, env?: object): RuntimeRequirement[];
export declare function burrowSetupUrl(origin: string, secret: string): string;
export declare function formatBurrowHandoff(input: {
    origin: string;
    bootstrapSecret?: string;
    requirements: readonly {
        title: string;
        fields: readonly {
            key: string;
            configured: boolean;
        }[];
    }[];
}): string;
