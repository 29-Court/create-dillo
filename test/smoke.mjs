// Dependency-free smoke test: asserts this package's identity.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(pkg.name, "dillo");
console.log("PASS: dillo smoke — package name is 'dillo'");
