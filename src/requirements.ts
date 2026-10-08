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

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

function assertHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${label} must be an absolute HTTP URL.`);
  }
  if (url.username || url.password) throw new TypeError(`${label} cannot contain credentials.`);
  return url.toString();
}

function endpoint(value: string | undefined, fallback: string, label: string): string {
  return assertHttpUrl(value ?? fallback, label);
}

function fields(requirements: readonly RequirementField[]): readonly RequirementField[] {
  for (const field of requirements) {
    if (!SECRET_NAME.test(field.key) || field.key.startsWith("ARMADILLO_")) {
      throw new TypeError(`Requirement \`${field.key}\` is not a usable runtime name.`);
    }
    if (field.type !== "config" && field.type !== "secret") {
      throw new TypeError(`Requirement \`${field.key}\` needs a config or secret type.`);
    }
    if (!field.label.trim()) throw new TypeError(`Requirement \`${field.key}\` needs a label.`);
  }
  return Object.freeze(requirements.map((field) => Object.freeze({ ...field })));
}

function signIn(definition: Omit<SignInProvider, "__armadilloSignIn" | "requirements"> & {
  requirements: readonly RequirementField[];
}): SignInProvider {
  if (!PROVIDER_ID.test(definition.id)) throw new TypeError(`Sign-in provider \`${definition.id}\` is invalid.`);
  if (definition.callbackPath !== `/auth/callback/${definition.id}`) {
    throw new TypeError(`Sign-in provider \`${definition.id}\` has the wrong callback path.`);
  }
  if (!definition.scopes.trim() || definition.scopes.length > 200) {
    throw new TypeError(`Sign-in provider \`${definition.id}\` needs scopes.`);
  }
  if (definition.profile !== "oidc" && definition.profile !== "github") {
    throw new TypeError(`Sign-in provider \`${definition.id}\` has an unknown profile.`);
  }
  if (definition.requirements.length === 0) throw new TypeError(`Sign-in provider \`${definition.id}\` needs requirements.`);
  return Object.freeze({
    __armadilloSignIn: true as const,
    id: definition.id,
    label: definition.label,
    callbackPath: definition.callbackPath,
    scopes: definition.scopes,
    authorizeUrl: assertHttpUrl(definition.authorizeUrl, `${definition.label} authorize URL`),
    tokenUrl: assertHttpUrl(definition.tokenUrl, `${definition.label} token URL`),
    userInfoUrl: assertHttpUrl(definition.userInfoUrl, `${definition.label} user info URL`),
    profile: definition.profile,
    requirements: fields(definition.requirements),
  });
}

export function google(options: SignInEndpoints = {}): SignInProvider {
  return signIn({
    id: "google",
    label: "Google",
    callbackPath: "/auth/callback/google",
    scopes: "openid email profile",
    authorizeUrl: endpoint(options.authorizeUrl, "https://accounts.google.com/o/oauth2/v2/auth", "Google authorize URL"),
    tokenUrl: endpoint(options.tokenUrl, "https://oauth2.googleapis.com/token", "Google token URL"),
    userInfoUrl: endpoint(options.userInfoUrl, "https://openidconnect.googleapis.com/v1/userinfo", "Google user info URL"),
    profile: "oidc",
    requirements: [
      { key: "GOOGLE_CLIENT_ID", label: "Client ID", type: "config" },
      { key: "GOOGLE_CLIENT_SECRET", label: "Client secret", type: "secret" },
    ],
  });
}

export function github(options: SignInEndpoints = {}): SignInProvider {
  return signIn({
    id: "github",
    label: "GitHub",
    callbackPath: "/auth/callback/github",
    scopes: "read:user user:email",
    authorizeUrl: endpoint(options.authorizeUrl, "https://github.com/login/oauth/authorize", "GitHub authorize URL"),
    tokenUrl: endpoint(options.tokenUrl, "https://github.com/login/oauth/access_token", "GitHub token URL"),
    userInfoUrl: endpoint(options.userInfoUrl, "https://api.github.com/user", "GitHub user info URL"),
    profile: "github",
    requirements: [
      { key: "GITHUB_CLIENT_ID", label: "Client ID", type: "config" },
      { key: "GITHUB_CLIENT_SECRET", label: "Client secret", type: "secret" },
    ],
  });
}

export const auth = Object.freeze({ google, github });

export function integration(definition: {
  id: string;
  label: string;
  requirements: readonly RequirementField[];
}): IntegrationDeclaration {
  if (!PROVIDER_ID.test(definition.id)) throw new TypeError(`Integration \`${definition.id}\` is invalid.`);
  if (!definition.label.trim()) throw new TypeError(`Integration \`${definition.id}\` needs a label.`);
  if (definition.requirements.length === 0) throw new TypeError(`Integration \`${definition.id}\` needs requirements.`);
  return Object.freeze({
    __armadilloIntegration: true as const,
    id: definition.id,
    label: definition.label,
    requirements: fields(definition.requirements),
  });
}

export function resend(): IntegrationDeclaration {
  return integration({
    id: "resend",
    label: "Resend",
    requirements: [{ key: "RESEND_API_KEY", label: "API key", type: "secret" }],
  });
}

export function customAuthProvider(value: unknown): ArmadilloAuthProvider | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { id?: unknown; authenticate?: unknown };
  if (typeof candidate.authenticate !== "function" || typeof candidate.id !== "string" || !candidate.id.trim()) {
    return undefined;
  }
  return value as ArmadilloAuthProvider;
}

function isSignIn(value: unknown): value is SignInProvider {
  return Boolean(value && typeof value === "object" && (value as SignInProvider).__armadilloSignIn === true);
}

function isIntegration(value: unknown): value is IntegrationDeclaration {
  return Boolean(value && typeof value === "object" && (value as IntegrationDeclaration).__armadilloIntegration === true);
}

function assertSignIn(value: unknown): SignInProvider {
  if (!isSignIn(value)) throw new TypeError("auth providers must be auth.google() or auth.github().");
  return signIn(value);
}

function assertIntegration(value: unknown): IntegrationDeclaration {
  if (!isIntegration(value)) throw new TypeError("email must be an integration such as resend().");
  return integration(value);
}

export function signInProviders(authValue: unknown): readonly SignInProvider[] {
  if (authValue === undefined || customAuthProvider(authValue)) return [];
  if (!Array.isArray(authValue)) return [];
  return authValue.map(assertSignIn);
}

export function assertRuntimeDeclarations(definition: { auth?: unknown; email?: unknown }): void {
  if (definition.auth !== undefined) {
    if (Array.isArray(definition.auth)) {
      if (definition.auth.length === 0) throw new TypeError("auth needs a sign-in provider.");
      const ids = new Set<string>();
      for (const provider of signInProviders(definition.auth)) {
        if (ids.has(provider.id)) throw new TypeError(`Duplicate sign-in provider: \`${provider.id}\`.`);
        ids.add(provider.id);
      }
    } else if (!customAuthProvider(definition.auth)) {
      throw new TypeError("auth must be customAuth() or a list of auth.google() and auth.github() providers.");
    }
  }
  if (definition.email !== undefined) assertIntegration(definition.email);
}

export function declaredSecretRequirements(definition: {
  auth?: unknown;
  email?: unknown;
}): { name: string; description: string; required: false }[] {
  const requirements: { name: string; description: string; required: false }[] = [];
  const add = (name: string, description: string) => {
    requirements.push({ name, description, required: false });
  };
  for (const provider of signInProviders(definition.auth)) {
    for (const field of provider.requirements) add(field.key, `${provider.label} ${field.label}`);
  }
  if (definition.email !== undefined) {
    for (const field of assertIntegration(definition.email).requirements) {
      add(field.key, `${assertIntegration(definition.email).label} ${field.label}`);
    }
  }
  return requirements;
}

function configured(env: object, key: string): boolean {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0;
}

function runtimeFields(
  requirements: readonly RequirementField[],
  env: object,
  required: boolean,
): RuntimeRequirementField[] {
  return requirements.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required,
    configured: configured(env, field.key),
  }));
}

export function resolveRequirements(definition: {
  auth?: unknown;
  email?: unknown;
  secrets?: Readonly<Record<string, {
    __armadilloSecret?: boolean;
    name?: string;
    required?: boolean;
  }>>;
}, env: object = {}): RuntimeRequirement[] {
  const requirements: RuntimeRequirement[] = [];
  const seen = new Set<string>();
  const take = (items: readonly RequirementField[]) => {
    const fresh = items.filter((field) => !seen.has(field.key));
    for (const field of fresh) seen.add(field.key);
    return fresh;
  };
  for (const provider of signInProviders(definition.auth)) {
    requirements.push({
      id: provider.id,
      title: provider.label,
      kind: "authentication",
      callbackPath: provider.callbackPath,
      fields: runtimeFields(take(provider.requirements), env, true),
    });
  }
  if (definition.email !== undefined) {
    const item = assertIntegration(definition.email);
    requirements.push({
      id: item.id,
      title: item.label,
      kind: "integration",
      fields: runtimeFields(take(item.requirements), env, true),
    });
  }
  const application = Object.entries(definition.secrets ?? {}).flatMap(([key, value]) => {
    if (!value || value.__armadilloSecret !== true) return [];
    const name = value.name ?? key;
    if (seen.has(name)) return [];
    seen.add(name);
    return [{ key: name, label: name, type: "secret" as const, required: value.required !== false }];
  });
  if (application.length > 0) {
    requirements.push({
      id: "application",
      title: "Application",
      kind: "integration",
      fields: application.map((field) => ({ ...field, configured: configured(env, field.key) })),
    });
  }
  return requirements;
}

export function burrowSetupUrl(origin: string, secret: string): string {
  const base = new URL(origin);
  return `${base.origin}/burrow#${encodeURIComponent(secret)}`;
}

export function formatBurrowHandoff(input: {
  origin: string;
  bootstrapSecret?: string;
  requirements: readonly { title: string; fields: readonly { key: string; configured: boolean }[] }[];
}): string {
  const lines: string[] = [];
  const missing = input.requirements.filter((requirement) => requirement.fields.some((field) => !field.configured));
  if (missing.length > 0) {
    const width = Math.max(16, ...missing.flatMap((requirement) => requirement.fields.map((field) => field.key.length)));
    lines.push("Setup required", "");
    for (const requirement of missing) {
      lines.push(requirement.title);
      for (const field of requirement.fields) {
        lines.push(`  ${field.key.padEnd(width)} ${field.configured ? "configured" : "missing"}`);
      }
      lines.push("");
    }
  }
  if (input.bootstrapSecret) {
    lines.push("Open Burrow:");
    lines.push(burrowSetupUrl(input.origin, input.bootstrapSecret));
  }
  return lines.join("\n").replace(/\n$/, "");
}
