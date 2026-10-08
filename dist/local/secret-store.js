import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
function rejectStore() {
  throw new Error("Burrow secret store is unreadable.");
}
function load(path, memory, env) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    rejectStore();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejectStore();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) rejectStore();
  for (const [key, value] of Object.entries(parsed)) {
    if (!NAME.test(key) || key.startsWith("ARMADILLO_") || typeof value !== "string") rejectStore();
    memory.set(key, value);
    env[key] = value;
  }
}
function attachSecretVault(databasePath, env) {
  const memory = /* @__PURE__ */ new Map();
  const path = databasePath === ":memory:" ? void 0 : resolve(dirname(resolve(databasePath)), "burrow-secrets.json");
  if (path) load(path, memory, env);
  const vault = {
    async put(name, value) {
      if (!NAME.test(name) || name.startsWith("ARMADILLO_")) {
        throw new Error("Burrow cannot store that secret name.");
      }
      memory.set(name, value);
      env[name] = value;
      if (!path) return;
      const body = JSON.stringify(Object.fromEntries([...memory].sort(([left], [right]) => left.localeCompare(right))));
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 384 });
      await rename(temporary, path);
      await chmod(path, 384);
    }
  };
  env.ARMADILLO_SECRET_VAULT = vault;
}
export {
  attachSecretVault
};
