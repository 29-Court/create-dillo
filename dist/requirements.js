const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
function assertHttpUrl(value, label) {
  let url;
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
function endpoint(value, fallback, label) {
  return assertHttpUrl(value ?? fallback, label);
}
function fields(requirements) {
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
function signIn(definition) {
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
    __armadilloSignIn: true,
    id: definition.id,
    label: definition.label,
    callbackPath: definition.callbackPath,
    scopes: definition.scopes,
    authorizeUrl: assertHttpUrl(definition.authorizeUrl, `${definition.label} authorize URL`),
    tokenUrl: assertHttpUrl(definition.tokenUrl, `${definition.label} token URL`),
    userInfoUrl: assertHttpUrl(definition.userInfoUrl, `${definition.label} user info URL`),
    profile: definition.profile,
    requirements: fields(definition.requirements)
  });
}
function google(options = {}) {
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
      { key: "GOOGLE_CLIENT_SECRET", label: "Client secret", type: "secret" }
    ]
  });
}
function github(options = {}) {
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
      { key: "GITHUB_CLIENT_SECRET", label: "Client secret", type: "secret" }
    ]
  });
}
const auth = Object.freeze({ google, github });
function integration(definition) {
  if (!PROVIDER_ID.test(definition.id)) throw new TypeError(`Integration \`${definition.id}\` is invalid.`);
  if (!definition.label.trim()) throw new TypeError(`Integration \`${definition.id}\` needs a label.`);
  if (definition.requirements.length === 0) throw new TypeError(`Integration \`${definition.id}\` needs requirements.`);
  return Object.freeze({
    __armadilloIntegration: true,
    id: definition.id,
    label: definition.label,
    requirements: fields(definition.requirements)
  });
}
function resend() {
  return integration({
    id: "resend",
    label: "Resend",
    requirements: [{ key: "RESEND_API_KEY", label: "API key", type: "secret" }]
  });
}
function customAuthProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const candidate = value;
  if (typeof candidate.authenticate !== "function" || typeof candidate.id !== "string" || !candidate.id.trim()) {
    return void 0;
  }
  return value;
}
function isSignIn(value) {
  return Boolean(value && typeof value === "object" && value.__armadilloSignIn === true);
}
function isIntegration(value) {
  return Boolean(value && typeof value === "object" && value.__armadilloIntegration === true);
}
function assertSignIn(value) {
  if (!isSignIn(value)) throw new TypeError("auth providers must be auth.google() or auth.github().");
  return signIn(value);
}
function assertIntegration(value) {
  if (!isIntegration(value)) throw new TypeError("email must be an integration such as resend().");
  return integration(value);
}
function signInProviders(authValue) {
  if (authValue === void 0 || customAuthProvider(authValue)) return [];
  if (!Array.isArray(authValue)) return [];
  return authValue.map(assertSignIn);
}
function assertRuntimeDeclarations(definition) {
  if (definition.auth !== void 0) {
    if (Array.isArray(definition.auth)) {
      if (definition.auth.length === 0) throw new TypeError("auth needs a sign-in provider.");
      const ids = /* @__PURE__ */ new Set();
      for (const provider of signInProviders(definition.auth)) {
        if (ids.has(provider.id)) throw new TypeError(`Duplicate sign-in provider: \`${provider.id}\`.`);
        ids.add(provider.id);
      }
    } else if (!customAuthProvider(definition.auth)) {
      throw new TypeError("auth must be customAuth() or a list of auth.google() and auth.github() providers.");
    }
  }
  if (definition.email !== void 0) assertIntegration(definition.email);
}
function declaredSecretRequirements(definition) {
  const requirements = [];
  const add = (name, description) => {
    requirements.push({ name, description, required: false });
  };
  for (const provider of signInProviders(definition.auth)) {
    for (const field of provider.requirements) add(field.key, `${provider.label} ${field.label}`);
  }
  if (definition.email !== void 0) {
    for (const field of assertIntegration(definition.email).requirements) {
      add(field.key, `${assertIntegration(definition.email).label} ${field.label}`);
    }
  }
  return requirements;
}
function configured(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}
function runtimeFields(requirements, env, required) {
  return requirements.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required,
    configured: configured(env, field.key)
  }));
}
function resolveRequirements(definition, env = {}) {
  const requirements = [];
  const seen = /* @__PURE__ */ new Set();
  const take = (items) => {
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
      fields: runtimeFields(take(provider.requirements), env, true)
    });
  }
  if (definition.email !== void 0) {
    const item = assertIntegration(definition.email);
    requirements.push({
      id: item.id,
      title: item.label,
      kind: "integration",
      fields: runtimeFields(take(item.requirements), env, true)
    });
  }
  const application = Object.entries(definition.secrets ?? {}).flatMap(([key, value]) => {
    if (!value || value.__armadilloSecret !== true) return [];
    const name = value.name ?? key;
    if (seen.has(name)) return [];
    seen.add(name);
    return [{ key: name, label: name, type: "secret", required: value.required !== false }];
  });
  if (application.length > 0) {
    requirements.push({
      id: "application",
      title: "Application",
      kind: "integration",
      fields: application.map((field) => ({ ...field, configured: configured(env, field.key) }))
    });
  }
  return requirements;
}
function burrowSetupUrl(origin, secret) {
  const base = new URL(origin);
  return `${base.origin}/burrow#${encodeURIComponent(secret)}`;
}
function formatBurrowHandoff(input) {
  const lines = [];
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
export {
  assertRuntimeDeclarations,
  auth,
  burrowSetupUrl,
  customAuthProvider,
  declaredSecretRequirements,
  formatBurrowHandoff,
  github,
  google,
  integration,
  resend,
  resolveRequirements,
  signInProviders
};
