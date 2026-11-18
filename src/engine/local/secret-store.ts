import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArmadilloSecretVault } from "../engine/environment.js";

const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

function rejectStore(): never {
  throw new Error("Burrow secret store is unreadable.");
}

function load(path: string, memory: Map<string, string>, env: Record<string, unknown>): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    rejectStore();
  }
  let parsed: unknown;
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

/** Local stand-in for platform secrets. Values stay in a 0600 file, not in the database. */
export function attachSecretVault(databasePath: string, env: Record<string, unknown>): void {
  const memory = new Map<string, string>();
  const path = databasePath === ":memory:" ? undefined : resolve(dirname(resolve(databasePath)), "burrow-secrets.json");
  if (path) load(path, memory, env);
  const vault: ArmadilloSecretVault = {
    async put(name: string, value: string): Promise<void> {
      if (!NAME.test(name) || name.startsWith("ARMADILLO_")) {
        throw new Error("Burrow cannot store that secret name.");
      }
      memory.set(name, value);
      env[name] = value;
      if (!path) return;
      const body = JSON.stringify(Object.fromEntries([...memory].sort(([left], [right]) => left.localeCompare(right))));
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
  };
  env.ARMADILLO_SECRET_VAULT = vault;
}
