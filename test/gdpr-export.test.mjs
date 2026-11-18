// DEF-D3 regression proof: a GDPR export must complete when a stored
// row carries non-JSON legacy bytes in a JSON column.
//
// Before the guard, gdprRoute's export bundle assembly ran bare
// JSON.parse on stored rows (consents.metadata, api-keys.scopes,
// objects.data, collector-submissions.data, tickets.metadata), so ONE
// legacy row threw and failed the entire export. The guard's stated
// policy (engine/gdpr.ts, storedJson): a value that parses is returned
// exactly as parsed; a value that does not parse is preserved
// byte-for-byte under `$unparsed`. Scopes are the one exception: an
// unparseable scope list exports as [] (configuration, not subject
// data — the apiKeyJson posture).
//
// This test runs the REAL gdprRoute (bundled from source with the
// repo's rolldown, the same tool build.mjs uses) against a fake D1
// whose fixture rows include non-JSON legacy values in every guarded
// column, and asserts the export completes with each row handled per
// that policy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolldown } from "rolldown";

const tmp = mkdtempSync(join(tmpdir(), "dillo-gdpr-"));
const bundlePath = join(tmp, "gdpr.mjs");
try {
  const bundle = await rolldown({
    input: new URL("../src/engine/engine/gdpr.ts", import.meta.url).pathname,
  });
  await bundle.write({ file: bundlePath, format: "esm" });
  const { gdprRoute, storedJson } = await import(bundlePath);

  // ---- unit level: the guard itself --------------------------------
  assert.deepEqual(storedJson('{"a":1}'), { a: 1 }, "valid JSON parses exactly");
  assert.deepEqual(storedJson("[1,2]"), [1, 2], "valid JSON array parses exactly");
  assert.deepEqual(
    storedJson("legacy plain text, not json"),
    { $unparsed: "legacy plain text, not json" },
    "non-JSON legacy bytes are preserved under $unparsed",
  );

  // ---- fixture D1 ---------------------------------------------------
  const USER = {
    id: "u_legacy", email: "legacy@example.com", name: "Legacy User",
    password_hash: "x", password_salt: "x", password_iterations: 1,
    password_enabled: 0, profile: "{}",
    created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-02T00:00:00.000Z",
    auth_method: "session",
  };
  const CONSENTS = [
    { id: "c1", purpose: "marketing", granted: 1, metadata: '{"via":"web"}', created_at: "2024-02-01T00:00:00.000Z", updated_at: "2024-02-01T00:00:00.000Z", expires_at: null },
    { id: "c2", purpose: "analytics", granted: 0, metadata: "paper form, 2019 import", created_at: "2019-05-01T00:00:00.000Z", updated_at: "2019-05-01T00:00:00.000Z", expires_at: null },
  ];
  const API_KEYS = [
    { id: "k1", name: "legacy key", key_prefix: "ak_legacy", scopes: "tables:read, tables:write", created_at: "2023-03-01T00:00:00.000Z" },
  ];
  const OBJECTS = [
    { collection: "notes", id: "o1", data: '{"note":"structured"}', created_at: "2024-03-01T00:00:00.000Z", updated_at: "2024-03-01T00:00:00.000Z" },
    { collection: "notes", id: "o2", data: "legacy plain text, not json", created_at: "2018-03-01T00:00:00.000Z", updated_at: "2018-03-01T00:00:00.000Z" },
  ];
  const SUBMISSIONS = [
    { id: "s1", collector_id: "col1", data: "Name: Jane; picked: apples", created_at: "2019-04-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" },
  ];
  const TICKETS = [
    { id: "t1", label: "paper ticket", metadata: "paper ticket stub #42", created_at: "2019-05-01T00:00:00.000Z" },
  ];

  function prepare(sql) {
    const stmt = {
      bind() { return stmt; },
      async first() {
        if (sql.includes("_armadillo_sessions") && sql.includes("JOIN")) return USER;
        if (sql.includes("_armadillo_rate_limits")) {
          return { count: 1, reset_at: new Date(Date.now() + 3_600_000).toISOString() };
        }
        return null;
      },
      async all() {
        if (sql.includes("_armadillo_gdpr_consents")) return { results: CONSENTS };
        if (sql.includes("_armadillo_api_keys")) return { results: API_KEYS };
        if (sql.includes("_armadillo_objects")) return { results: OBJECTS };
        if (sql.includes("_armadillo_collector_submissions")) return { results: SUBMISSIONS };
        if (sql.includes("_armadillo_tickets")) return { results: TICKETS };
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    };
    return stmt;
  }
  const env = { DB: { prepare } };
  const auth = { authorization: "Bearer test-token" };

  // ---- the export itself: completes despite the legacy rows --------
  const res = await gdprRoute(
    new Request("https://api.example/v1/gdpr/export", { method: "POST", headers: auth }),
    env, "app_fixture", {}, "export",
  );
  assert.equal(res.status, 200, `export completes (got ${res.status})`);
  const { bundle: b } = await res.json();

  assert.deepEqual(b.objects.find((o) => o.id === "o1").data, { note: "structured" },
    "valid object row exports parsed");
  assert.deepEqual(b.objects.find((o) => o.id === "o2").data, { $unparsed: "legacy plain text, not json" },
    "legacy object row preserved under $unparsed, export not failed");
  assert.deepEqual(b.consents.find((c) => c.id === "c1").metadata, { via: "web" },
    "valid consent metadata exports parsed");
  assert.deepEqual(b.consents.find((c) => c.id === "c2").metadata, { $unparsed: "paper form, 2019 import" },
    "legacy consent metadata preserved under $unparsed");
  assert.deepEqual(b.apiKeys[0].scopes, [],
    "unparseable legacy scopes export as [] (apiKeyJson posture)");
  assert.deepEqual(b.collectorSubmissions[0].data, { $unparsed: "Name: Jane; picked: apples" },
    "legacy submission data preserved under $unparsed");
  assert.deepEqual(b.tickets[0].metadata, { $unparsed: "paper ticket stub #42" },
    "legacy ticket metadata preserved under $unparsed");

  // ---- the consents read route carries the same guard ---------------
  const res2 = await gdprRoute(
    new Request("https://api.example/v1/gdpr/consents", { method: "GET", headers: auth }),
    env, "app_fixture", {}, "consents",
  );
  assert.equal(res2.status, 200, "consents route completes on legacy metadata");
  const { consents } = await res2.json();
  assert.deepEqual(consents.find((c) => c.id === "c2").metadata, { $unparsed: "paper form, 2019 import" });

  console.log("PASS: gdpr export guard — export completes with non-JSON legacy rows; each handled per the $unparsed policy (scopes [])");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
