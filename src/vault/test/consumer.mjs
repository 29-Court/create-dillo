// Drives the Flows-side consumer proof (vault_proof.mjs) against the REAL
// Dillo Vault under wrangler dev. Same throwaway-KEK + local-D1 discipline
// as proof.mjs; nothing here deploys or persists a secret.
//
// Run: node dillo/src/vault/test/consumer.mjs [--port N]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "..");
const repo = join(vaultDir, "..", "..", "..");
const port = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 8789;
const base = `http://127.0.0.1:${port}`;

function run(cmd, args, cwd, inherit = false) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    if (inherit) { p.on("close", (code) => resolve(code)); return; }
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const kek = randomBytes(32).toString("base64");
const mig = await run("npx", ["--yes", "wrangler", "d1", "migrations", "apply", "DB", "--local"], vaultDir);
if (mig.code !== 0) { console.error("migrations apply failed:", mig.out); process.exit(1); }
console.log(`[consumer] migrations applied; spawning wrangler dev on :${port}`);
const child = spawn("npx", ["--yes", "wrangler", "dev", "--port", String(port), "--var", `VAULT_KEK:${kek}`, "--var", "VAULT_CONSOLE_SECRET:console-caller-fixture", "--var", "VAULT_TEST_DOUBLE:1"], {
  cwd: vaultDir, stdio: ["ignore", "ignore", "inherit"], detached: true,
  env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
});
let ready = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + "/health"); if (r.ok) { ready = true; break; } } catch {}
  await new Promise((res) => setTimeout(res, 500));
}
if (!ready) { console.error("FAIL: wrangler dev did not become ready"); try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } process.exit(1); }

console.log(`[consumer] running vault_proof.mjs --target ${base}`);
const code = await run("node", [join(repo, "surfaces/flows/tools/proofs/vault_proof.mjs"), "--target", base], repo, true);

try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
process.exit(code === 0 ? 0 : 1);
