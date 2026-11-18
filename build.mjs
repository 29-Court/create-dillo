// Build dillo's TypeScript sources to dist/ with rolldown — the
// bundler vendored in this repo's node_modules (there is no tsc in
// the repo toolchain: typescript appears in the lockfile only as a
// peer range and is not installed; no network installs). rolldown
// transpiles TS natively. dist/ is committed: Workers and tests
// import the built ESM directly, with no build step at consume time.
// Declarations in dist/ are maintained beside the sources they mirror
// (dist/auth/index.d.ts) until a tsc is vendored.
import { rolldown } from "rolldown";
import { mkdirSync } from "node:fs";

const entries = [
  { input: "src/auth/index.ts", file: "dist/auth/index.js" },
];

for (const e of entries) {
  const bundle = await rolldown({ input: e.input });
  mkdirSync(new URL(".", "file://" + process.cwd() + "/" + e.file).pathname, { recursive: true });
  await bundle.write({ file: e.file, format: "esm" });
  console.log(`built ${e.input} -> ${e.file}`);
}
