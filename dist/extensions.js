const NEVER_EXPOSED_TO_EXTENSIONS = /* @__PURE__ */ new Set([
  "DB",
  "FILES",
  "ARMADILLO_ADMIN_KEY",
  "ARMADILLO_BOOTSTRAP_SECRET",
  "ARMADILLO_SECRET_VAULT",
  "MAIL_QUEUE",
  "ARMADILLO_REALTIME",
  "RESEND_API_KEY",
  "CF_EMAIL_API_TOKEN",
  "CF_ACCOUNT_ID",
  "R2_SECRET_ACCESS_KEY"
]);
const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|_KEY$|^KEY$|CREDENTIAL)/i;
function extensionRuntimeView(env, declaredSecrets) {
  const allowed = new Set(
    declaredSecrets.filter((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && !NEVER_EXPOSED_TO_EXTENSIONS.has(name))
  );
  const view = /* @__PURE__ */ Object.create(null);
  const deny = /* @__PURE__ */ new Set();
  for (const key in env) {
    if (deny.has(key)) continue;
    deny.add(key);
    if (NEVER_EXPOSED_TO_EXTENSIONS.has(key)) continue;
    if (allowed.has(key)) {
      view[key] = env[key];
      continue;
    }
    if (SECRET_NAME.test(key) || key.startsWith("ARMADILLO_")) continue;
    view[key] = env[key];
  }
  return Object.freeze(view);
}
function extensionRequestView(request) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-armadillo-admin-key");
  headers.delete("x-armadillo-bootstrap-secret");
  headers.delete("x-armadillo-client-key");
  return new Request(request.url, { method: request.method, headers });
}
function defineExtension(extension) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(extension.name)) {
    throw new TypeError("Extension names must use lowercase letters, numbers, and hyphens.");
  }
  for (const requirement of extension.requirements?.secrets ?? []) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(requirement.name)) {
      throw new TypeError(`Extension secret requirement \`${requirement.name}\` is invalid.`);
    }
  }
  for (const requirement of extension.requirements?.infrastructure ?? []) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(requirement.name) || !["queue", "storage", "webhook", "service"].includes(requirement.kind)) {
      throw new TypeError(`Extension infrastructure requirement \`${requirement.name}\` is invalid.`);
    }
  }
  return { ...extension, functions: extension.functions ?? {} };
}
async function resolveExtensionEnvironment(extensions, context) {
  const environment = /* @__PURE__ */ Object.create(null);
  for (const extension of extensions ?? []) {
    const declared = (extension.requirements?.secrets ?? []).map((requirement) => requirement.name);
    const scoped = {
      appId: context.appId,
      request: extensionRequestView(context.request),
      runtime: extensionRuntimeView(context.runtime, declared)
    };
    const contribution = typeof extension.env === "function" ? await extension.env(scoped) : extension.env;
    if (!contribution) continue;
    if (typeof contribution !== "object" || Array.isArray(contribution)) {
      throw new TypeError(`Extension ${extension.name} must provide an environment object.`);
    }
    for (const [name, value] of Object.entries(contribution)) {
      if (Object.hasOwn(environment, name)) {
        throw new Error(`Extensions may not both provide env.${name}.`);
      }
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}
export {
  defineExtension,
  extensionRequestView,
  extensionRuntimeView,
  resolveExtensionEnvironment
};
