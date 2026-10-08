import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { buildSync } from "esbuild";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { requiredSecrets } from "../backend.js";
import { uniqueUserProfileFields, userProfileUniqueIndexSql } from "../schema.js";
import { appCapabilities } from "../capabilities.js";
import { migrations } from "../migrations.js";
import { HTTP_API_PREFIX } from "../versions.js";
const compatibilityDate = "2026-07-11";
function migrationFiles(extra = [], profileSql = "", appId = "") {
  const require2 = createRequire(import.meta.url);
  const directory = resolve(dirname(require2.resolve("create-dillo/client-script")), "../migrations");
  const core = migrations.map(({ id, checksum, sql }) => {
    const path = resolve(directory, id);
    const packaged = readFileSync(path, "utf8");
    if (packaged !== sql || createHash("sha256").update(packaged).digest("hex") !== checksum) {
      throw new Error(`Immutable core migration checksum mismatch: ${id}`);
    }
    return path;
  });
  const generated = profileIndexFile(profileSql, appId);
  return [
    ...core,
    ...extra.map((file) => resolve(process.cwd(), file)),
    ...generated ? [generated] : []
  ];
}
function cloudflareProfileIndexSql(backend) {
  const fields = uniqueUserProfileFields(backend.schema?.normalized);
  if (fields.length === 0) return "";
  return `${fields.map((field) => userProfileUniqueIndexSql(field)).join("\n")}
`;
}
function cloudflareD1ImportPaths(backend, extra = [], appId = "") {
  return migrationFiles(extra, cloudflareProfileIndexSql(backend), appId);
}
function profileIndexFile(sql, appId) {
  if (!sql.trim()) return void 0;
  const directory = resolve(
    tmpdir(),
    "armadillo",
    createHash("sha256").update(`${process.cwd()}
${appId}`).digest("hex").slice(0, 16),
    "d1"
  );
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "profile-unique-indexes.sql");
  writeFileSync(path, sql);
  return path;
}
function isLocalDevelopment() {
  return process.env.ALCHEMY_DEV === "true";
}
function deploymentState() {
  return isLocalDevelopment() ? Alchemy.localState() : Cloudflare.state();
}
function resourceName(value) {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("") || "App";
}
function buildCloudflareWorker(entrypoint) {
  const directory = resolve(
    tmpdir(),
    "armadillo",
    createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)
  );
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, "worker.js");
  if (entrypoint) {
    buildSync({
      entryPoints: [resolve(process.cwd(), entrypoint)],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "es2022",
      minify: true,
      legalComments: "none",
      loader: { ".css": "text", ".html": "text", ".txt": "text", ".bundle.js": "text" }
    });
    return output;
  }
  const source = `
import { cloudflare, ArmadilloRealtime } from "create-dillo/cloudflare";
import backend from "./backend.ts";

export { ArmadilloRealtime };
export default cloudflare(backend);
`.trimStart();
  buildSync({
    stdin: {
      contents: source,
      resolveDir: process.cwd(),
      sourcefile: "armadillo-entry.ts",
      loader: "ts"
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    minify: true,
    legalComments: "none",
    loader: { ".css": "text", ".html": "text", ".txt": "text", ".bundle.js": "text" }
  });
  return output;
}
function protectedAssets(assets, backend) {
  const config = typeof assets === "string" ? { directory: assets } : assets;
  if (config.runWorkerFirst === true) return config;
  const extra = Array.isArray(config.runWorkerFirst) ? config.runWorkerFirst : [];
  if (extra.some((rule) => rule.startsWith("!"))) {
    throw new Error("Asset runWorkerFirst exclusions can bypass Dillo API and UI routes. Use positive route patterns only.");
  }
  return {
    ...config,
    runWorkerFirst: [.../* @__PURE__ */ new Set([
      HTTP_API_PREFIX,
      `${HTTP_API_PREFIX}/*`,
      "/auth/*",
      "/armadillo/*",
      "/client.js",
      "/health",
      ...Object.values(backend.ui?.apps ?? {}).map((page) => page.path),
      ...extra
    ])]
  };
}
function cloudflareAuthoritySecrets(options = {}) {
  return [
    ...(options.signup ?? "closed") === "closed" ? ["ARMADILLO_BOOTSTRAP_SECRET"] : [],
    ...options.adminKey ? ["ARMADILLO_ADMIN_KEY"] : []
  ];
}
function app(options) {
  validateCloudflareBackend(options.backend, options.bindings);
  const name = resourceName(options.name ?? options.id);
  const signup = options.signup ?? "closed";
  const database = Cloudflare.D1.Database(`${name}Database`, {
    importFiles: cloudflareD1ImportPaths(options.backend, options.migrationFiles ?? [], options.id)
  });
  const capabilities = appCapabilities(options.backend);
  const files = capabilities.files ? Cloudflare.R2.Bucket(`${name}Files`) : void 0;
  return Alchemy.Stack(
    // A local stack name is a second isolation boundary: it can never share
    // resource records with the deployed stack, even if state wiring regresses.
    `Armadillo${name}${isLocalDevelopment() ? "Local" : ""}`,
    { providers: Cloudflare.providers(), state: deploymentState() },
    Effect.gen(function* () {
      const stage = yield* Alchemy.Stage;
      const env = {
        DB: database,
        ...files ? { FILES: files } : {},
        ARMADILLO_APP_ID: options.id,
        ARMADILLO_STAGE: stage,
        ARMADILLO_SIGNUP_MODE: signup,
        ...options.adminGroup ? { ARMADILLO_SUPERADMIN_GROUP: options.adminGroup } : {},
        ...Object.fromEntries(cloudflareAuthoritySecrets({
          signup,
          ...options.adminKey ? { adminKey: true } : {}
        }).map((name2) => [name2, Config.redacted(name2)])),
        CORS_ORIGIN: options.corsOrigin ?? "*",
        ...options.mail ? {
          ARMADILLO_MAIL_FROM: options.mail.from,
          ARMADILLO_MAIL_BRAND_NAME: options.mail.brand ?? options.id,
          ...options.mail.accentColor ? { ARMADILLO_MAIL_ACCENT_COLOR: options.mail.accentColor } : {},
          ...options.mail.provider === "resend" ? { RESEND_API_KEY: Config.redacted("RESEND_API_KEY") } : {},
          ...options.mail.provider === "cloudflare" ? {
            CF_EMAIL_API_TOKEN: Config.redacted("CF_EMAIL_API_TOKEN"),
            CF_ACCOUNT_ID: Config.string("CF_ACCOUNT_ID")
          } : {},
          ...typeof options.mail.provider === "object" ? {
            ARMADILLO_MAIL_WEBHOOK: options.mail.provider.webhook,
            ...options.mail.provider.token ? { ARMADILLO_MAIL_WEBHOOK_TOKEN: options.mail.provider.token } : {}
          } : {}
        } : {},
        ...capabilities.realtime ? { ARMADILLO_REALTIME: Cloudflare.DurableObject("ArmadilloRealtime") } : {},
        ...Object.fromEntries(requiredSecrets(options.backend).map((secret) => [secret.name, secret.required ? Config.redacted(secret.name) : Config.redacted(secret.name).pipe(Config.withDefault(void 0))])),
        ...options.bindings ?? {}
      };
      const worker = Cloudflare.Worker(`${name}Worker`, {
        ...options.worker,
        main: buildCloudflareWorker(options.entrypoint),
        // Dillo bundles its adapter (or the app's route shell) to a small
        // portable Worker module before handing it to Alchemy.
        bundle: false,
        ...options.assets ? { assets: protectedAssets(options.assets, options.backend) } : {},
        compatibility: { date: compatibilityDate, ...options.worker?.compatibility, flags: [.../* @__PURE__ */ new Set(["global_fetch_strictly_public", ...options.worker?.compatibility?.flags ?? []])] },
        env,
        crons: ["*/15 * * * *"],
        observability: { enabled: true, logs: { enabled: true, invocationLogs: true } }
      });
      const deployedDatabase = yield* database;
      const deployedFiles = files ? yield* files : void 0;
      const deployedWorker = yield* worker;
      return {
        url: deployedWorker.url,
        stage,
        appId: options.id,
        database: deployedDatabase.databaseName,
        bucket: deployedFiles?.bucketName
      };
    })
  );
}
function validateCloudflareBackend(backend, bindings = {}) {
  appCapabilities(backend);
  const reserved = /* @__PURE__ */ new Set(["resources", "DB", "FILES", "MAIL_QUEUE", "CORS_ORIGIN", ...requiredSecrets(backend).map((s) => s.name)]);
  for (const key of Object.keys(bindings)) {
    if (reserved.has(key) || key.startsWith("ARMADILLO_") || key.startsWith("R2_")) throw new Error(`Reserved binding collision: ${key}`);
  }
  for (const secret of requiredSecrets(backend)) {
    if (["DB", "FILES", "MAIL_QUEUE", "CORS_ORIGIN"].includes(secret.name) || secret.name.startsWith("ARMADILLO_") || secret.name.startsWith("R2_")) throw new Error(`Reserved secret name: ${secret.name}`);
  }
  for (const [name, definition] of Object.entries(backend.functions ?? {})) {
    if (definition.transaction) throw new Error(`Cloudflare D1 does not support callback transactions (function: ${name}). Use explicit trusted SQL batches or remove transaction: true.`);
  }
  for (const extension of backend.extensions ?? []) {
    for (const requirement of extension.requirements?.infrastructure ?? []) {
      if (requirement.kind === "storage" && requirement.name === "FILES") continue;
      if (requirement.kind === "webhook") continue;
      if (Object.hasOwn(bindings, requirement.name) && bindings[requirement.name] != null) continue;
      throw new Error(`Unsupported Cloudflare extension infrastructure: ${requirement.kind} ${requirement.name}. Supply a separately reviewed Alchemy recipe.`);
    }
  }
  for (const [name, table] of Object.entries(backend.schema?.normalized.tables ?? {})) {
    if (table.storage === "columns") throw new Error(`Cloudflare column-backed schema deployment requires an explicit upgrade plan (${name}); use JSON records for this release.`);
  }
}
export {
  app,
  buildCloudflareWorker,
  cloudflareAuthoritySecrets,
  cloudflareD1ImportPaths,
  cloudflareProfileIndexSql,
  validateCloudflareBackend
};
