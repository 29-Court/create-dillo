import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile, readdir, mkdir, writeFile, lstat, access } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { satisfies } from "semver";
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const compatibility = manifest.dilloCompatibility;
async function exists(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
async function scaffold(directory, { init = false, template = "minimal", install = false, json = false } = {}) {
  const target = resolve(directory);
  const state = await exists(target);
  if (state && (!init || !state.isDirectory() || state.isSymbolicLink())) throw new Error(`Directory already exists: ${target}. Use init in an existing directory.`);
  const source = new URL(`../templates/${template}/`, import.meta.url);
  const files = (await readdir(source, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(fileURLToPath(source), join(entry.parentPath, entry.name)));
  const writes = [];
  for (const templateFile of files) {
    const file = templateFile === "gitignore" ? ".gitignore" : templateFile;
    let content = await readFile(new URL(templateFile, source), "utf8");
    let parent = dirname(join(target, file));
    while (parent !== target) {
      const parentState = await exists(parent);
      if (parentState && (!parentState.isDirectory() || parentState.isSymbolicLink())) throw new Error(`Refusing to write through ${parent}. No files have been changed.`);
      parent = dirname(parent);
    }
    const current = await exists(join(target, file));
    if (current && (!["package.json", ".gitignore"].includes(file) || !init || !current.isFile() || current.isSymbolicLink())) throw new Error(`Refusing to overwrite ${file}. No files have been changed.`);
    if (file === ".gitignore" && current) {
      const previous = await readFile(join(target, file), "utf8");
      const lines = new Set(previous.split("\n"));
      content = previous + (previous.endsWith("\n") ? "" : "\n") + content.split("\n").filter((line) => line && !lines.has(line)).join("\n") + "\n";
    }
    if (file === "package.json") {
      const defaults = JSON.parse(content);
      defaults.name = target.split(/[\\/]/).at(-1).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "dillo-app";
      if (current) {
        const original = JSON.parse(await readFile(join(target, file), "utf8"));
        if (original.type && original.type !== "module") throw new Error("This template requires an ESM application (type: module). No files have been changed.");
        for (const field of ["dependencies", "devDependencies", "scripts", "overrides"]) {
          for (const key of Object.keys(defaults[field] ?? {})) if (original[field]?.[key] !== void 0 && original[field][key] !== defaults[field][key]) throw new Error(`Existing package.json ${field}.${key} conflicts with the template. No files have been changed.`);
          defaults[field] = { ...defaults[field], ...original[field] };
        }
        content = JSON.stringify({ ...original, type: "module", dependencies: defaults.dependencies, devDependencies: defaults.devDependencies, scripts: defaults.scripts, overrides: defaults.overrides }, null, 2) + "\n";
      } else content = JSON.stringify(defaults, null, 2) + "\n";
    }
    writes.push([file, content, Boolean(current)]);
  }
  await mkdir(target, { recursive: true });
  for (const [file, content, replacing] of writes) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), content, { flag: replacing ? "w" : "wx" });
  }
  if (install) {
    const engines = manifest.engines ?? {};
    const problems = [];
    if (engines.node && !satisfies(process.version, engines.node))
      problems.push(`node ${process.version} does not satisfy ${engines.node}`);
    const npmProbe = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8" });
    const npmVersion = npmProbe.stdout?.trim();
    if (npmProbe.error || npmProbe.status || !npmVersion) problems.push("could not determine the npm version");
    else if (engines.npm && !satisfies(npmVersion, engines.npm)) problems.push(`npm ${npmVersion} does not satisfy ${engines.npm}`);
    if (problems.length) throw new Error(
      `Cannot install dependencies: ${problems.join("; ")}. create-dillo requires node ${engines.node ?? "(unspecified)"} and npm ${engines.npm ?? "(unspecified)"}. Fix: npm install -g npm@11, then re-run with --install (or run npm install in ${target}). Project files are ready in ${target}.`
    );
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], { cwd: target, stdio: json ? "pipe" : "inherit" });
    if (result.error || result.status) throw new Error(`Project files are ready in ${target}; dependency installation failed. Run npm install there to retry.`);
  }
  return { directory: target, files: writes.map(([file]) => file).sort(), installed: install };
}
async function doctor(directory) {
  const target = resolve(directory);
  const missing = [];
  for (const file of ["package.json", "schema.ts", "backend.ts"]) if (!await exists(join(target, file))) missing.push(file);
  const config = await exists(join(target, "armadillo.config.ts")) ? "armadillo.config.ts" : await exists(join(target, "alchemy.run.ts")) ? "alchemy.run.ts" : void 0;
  if (!config) throw new Error("Missing project files: armadillo.config.ts (or alchemy.run.ts)");
  if (missing.length) throw new Error(`Missing project files: ${missing.join(", ")}`);
  const require2 = createRequire(join(target, "package.json"));
  let library;
  try {
    library = require2("create-dillo/package.json");
  } catch {
    throw new Error("Dillo is not installed in this application. Run npm install.");
  }
  if (!satisfies(library.version, compatibility)) throw new Error(`CLI ${manifest.version} requires Dillo ${compatibility}; this application has ${library.version}. Install a compatible CLI or library.`);
  let alchemy;
  try {
    alchemy = require2.resolve("alchemy/bin/alchemy.js");
  } catch {
    throw new Error("Alchemy is not installed in this application. Run npm install.");
  }
  return { directory: target, library: library.version, compatibility, alchemy, config, ok: true };
}
async function workflow(directory, command, stage) {
  const project = await doctor(directory);
  await assertCloudflareCredentials(command);
  const entry = resolve(dirname(project.alchemy), "cli.js");
  const result = spawnSync(process.execPath, [entry, command, project.config, ...stage ? ["--stage", stage] : []], { cwd: project.directory, stdio: "inherit", env: { ...process.env, ...command === "dev" ? { ALCHEMY_DEV: "true" } : {} } });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`Alchemy ${command} exited with status ${result.status}.`);
}
async function assertCloudflareCredentials(command) {
  if (!["dev", "deploy", "plan"].includes(command)) return;
  const profile = process.env.ALCHEMY_PROFILE || "default";
  const hasEnv = Boolean(
    (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_EMAIL) && process.env.CLOUDFLARE_ACCOUNT_ID
  );
  let hasStored = false;
  try {
    await access(join(homedir(), ".alchemy", "credentials", profile, "cloudflare.json"));
    hasStored = true;
  } catch {
  }
  if (hasEnv || hasStored) return;
  throw new Error(
    `create-dillo ${command} needs Cloudflare credentials (profile "${profile}"), and none were found. Without them alchemy dev fails to authenticate and parks forever instead of exiting. Run \`alchemy login\` (or \`alchemy login --profile ${profile}\`), or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The minimal template's \`npm run dev:local\` needs no Cloudflare account.`
  );
}
export {
  assertCloudflareCredentials,
  compatibility,
  doctor,
  scaffold,
  workflow
};
