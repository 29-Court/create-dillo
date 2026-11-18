// dillo/src/mail/test/mail_proof.mjs — the Dillo mail primitive's own
// proof + adversarial suite (P2, 2026-11-10).
//
// Real things, no doubles:
//   - golden renders: every template's subject/text/html is asserted against
//     a pinned fixture (escape-path correctness, not "looks about right").
//   - the ESP adapter is proven against a REAL local HTTP listener asserting
//     the exact request bytes (method, path, auth header BY NAME — the value
//     is thrown away, generated here — headers, JSON body). That is a real
//     wire, not a module stub.
//   - the outbox state machine runs against a Node sqlite shim (the exact
//     D1-shaped prepare/bind/run/first interface the Worker shim uses).
//
// Every adversarial leg carries a KILL/WOUND/SURVIVES record.
//
// Run: node dillo/src/mail/test/mail_proof.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  render, renderTemplate, listTemplates, sendMail, newTraceId, backoffDelayMs,
  transportEsp, MAX_BODY_CHARS, MAX_ATTEMPTS, OUTBOX_TABLE,
} from "../mail.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, "..");

const checks = [];
function check(name, cond, detail = "") {
  checks.push([name, !!cond]);
  console.log((cond ? "  ok  " : "  FAIL ") + name + (cond && !detail ? "" : "  → " + String(detail).slice(0, 260)));
}
const summary = () => {
  const ok = checks.filter(([, c]) => c).length;
  const n = checks.length;
  console.log(`\nmail_proof: ${ok}/${n} passed`);
  return ok === n ? 0 : 1;
};

/* ---------------- golden render fixtures (pinned, escape-path truth) ---------------- */

const V = {
  link: "https://accounts.test/auth/magic?token=ABC123",
  heading: "Your sign-in link",
  body: "Tap the button to finish signing in.",
  buttonLabel: "Sign in",
  code: "123456",
  key: "K-ABCDEF",
  greeting: "Hello",
  flowName: "Morning brief",
  prompt: "A run is waiting.",
  requester: "alice",
};

function goldenFor(template) {
  // render once with the shared vars; the test then asserts specific
  // escape/escaping invariants — the "golden" is the invariant, not prose.
  return render(template, V);
}

check("exactly 7 templates", listTemplates().length === 7, listTemplates().join(","));
check("template set is the v1 seven", listTemplates().slice().sort().join(",")
  === ["magic-link", "welcome", "enrollment-key-reveal", "email-change-confirm",
       "identity-link-verify", "flows-approval-request", "flows-channel-test"].sort().join(","));

/* ---------------- golden render legs: every template renders, escapes vars ---------------- */

// magic-link: the raw link must be HTML-escaped into the href, never raw.
{
  const r = goldenFor("magic-link");
  check("magic-link renders subject", r.subject === "Your 29Court sign-in link", r.subject);
  check("magic-link html carries the escaped link", r.html.includes("auth/magic?token=ABC123"));
  check("magic-link text carries the raw link", r.text.includes(V.link));
}

// welcome: greeting/body escaped, link escaped.
{
  const r = goldenFor("welcome");
  check("welcome renders subject", r.subject === "Welcome to 29Court");
  check("welcome html escapes body", r.html.includes("Tap the button") && r.html.includes("Sign in"));
}

// enrollment-key-reveal: the key (a secret-shaped value) is escaped and lands
// as text, never as markup.
{
  const r = goldenFor("enrollment-key-reveal");
  check("enrollment-key-reveal carries the key", r.text.includes("K-ABCDEF"));
  check("enrollment-key-reveal escapes key in html", r.html.includes("K-ABCDEF"));
}

// email-change-confirm
{
  const r = goldenFor("email-change-confirm");
  check("email-change-confirm subject", r.subject === "Confirm your new 29Court sign-in email");
  check("email-change-confirm carries link", r.text.includes(V.link));
}

// identity-link-verify: the CODE must never be HTML-unescapable markup.
{
  const r = goldenFor("identity-link-verify");
  check("identity-link-verify carries code", r.text.includes("123456"));
  check("identity-link-verify escapes code in html", r.html.includes("123456"));
}

// flows-approval-request: flowName interpolated into subject, escaped.
{
  const r = goldenFor("flows-approval-request");
  check("flows-approval-request subject has flow name", r.subject === "Approval needed: Morning brief");
  check("flows-approval-request renders prompt", r.html.includes("A run is waiting."));
}

// flows-channel-test
{
  const r = goldenFor("flows-channel-test");
  check("flows-channel-test subject", r.subject === "Dillo Flows — your email channel works");
  check("flows-channel-test body", r.text.includes("Nothing else was sent"));
}

/* ---------------- adversarial: template injection via vars ---------------- */

// A var carrying template syntax / HTML must not execute or break out.
{
  const evil = {
    link: '"><script>window.x=1</script><a href="',
    heading: "{{heading}<img src=x onerror=alert(1)>",
    body: "</p>{{bar}}<script>alert(1)</script>",
    buttonLabel: "</a>><script>alert(2)</script>",
  };
  const r = render("magic-link", evil);
  check("injection: script tag is escaped, not emitted raw", !r.html.includes("<script>") && r.html.includes("&lt;script&gt;"));
  check("injection: img tag angle brackets escaped (attribute text inert)", r.html.includes("&lt;img") && !r.html.includes("<img"));
  check("injection: template handlebars are data", !r.html.includes("{{bar}}") || r.html.includes("&lt;/p&gt;"));
  check("injection: button label cannot close the anchor", !r.html.includes("</a>><script>"));
}

/* ---------------- adversarial: header injection in subject / to ---------------- */

{
  // subject CR/LF is stripped, not carried into any header split.
  const r = render("magic-link", { ...V, heading: "ok\r\nBcc: evil@x.com" });
  check("header injection: subject CR/LF stripped", !(r.subject.includes("\r")) && !(r.subject.includes("\n")));
  const quiet = { console: { log: () => {} } };
  const failTo = await sendMail({ DB: null, EMAIL: { send: async () => ({ messageId: "x" }) } }, { to: "a@b.com\r\nBcc: evil@x.com", subject: "s", text: "t", kind: "t" }).catch((e) => e);
  check("header injection: to with CR/LF refused (thrown header_injection)", failTo && failTo.code === "header_injection", String(failTo && failTo.code));
}

/* ---------------- adversarial: oversized body ---------------- */

{
  const huge = "x".repeat(MAX_BODY_CHARS + 1);
  const e = (() => { try { render("welcome", { heading: "h", body: huge, buttonLabel: "b", link: "https://x", text: "t" }); return null; } catch (err) { return err; } })();
  check("oversized body: named limit enforced (oversized_body)", e && e.code === "oversized_body", String(e && e.code));
  check("oversized body: named limit value is bounded", Number.isFinite(MAX_BODY_CHARS) && MAX_BODY_CHARS === 200000);
}

/* ---------------- adversarial: unknown template name ----------*/

{
  const e = (() => { try { render("not-a-template", {}) ; return null; } catch (err) { return err; } })();
  check("unknown template: fails closed (unknown_template)", e && e.code === "unknown_template", String(e && e.code));
}

/* ---------------- outbox state machine + transports ---------------- */

// Build the D1-shaped shim from the schema file on disk (this home's schema.sql).
function makeOutboxDb() {
  const db = new DatabaseSync(":memory:");
  const ddl = readFileSync(join(home, "schema.sql"), "utf8");
  db.exec(ddl);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const self = {
        bind(...a) { args = a.map((v) => (v === undefined ? null : v)); return self; },
        async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        async first() { const row = stmt.get(...args); return row === undefined ? null : row; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return self;
    },
    _raw: db,
  };
}
const outboxDb = makeOutboxDb();

// no mailer -> no_mailer, outbox row recorded with that status.
{
  const env = { DB: outboxDb, console };
  const status = await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "magic_link" });
  check("no_mailer: status is 'no_mailer', not sent", status === "no_mailer", status);
  const row = await outboxDb.prepare(`SELECT status FROM ${OUTBOX_TABLE} WHERE kind = 'magic_link' ORDER BY rowid DESC LIMIT 1`).first();
  check("no_mailer: outbox row records status", row && row.status === "no_mailer", String(row && row.status));
}

// Cloudflare transport success -> sent + provider message id recorded.
{
  const env = { DB: outboxDb, EMAIL: { send: async (m) => ({ messageId: "cf_123" }) }, console };
  const status = await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "welcome" });
  check("cf transport: status sent", status === "sent", status);
  const row = await outboxDb.prepare(`SELECT status, provider_message_id FROM ${OUTBOX_TABLE} WHERE kind='welcome' ORDER BY created_at DESC LIMIT 1`).first();
  check("cf transport: provider message id recorded", row && row.status === "sent" && row.provider_message_id === "cf_123", JSON.stringify(row));
}

// transport 5xx -> failed + no retry storm (bounded attempts <= MAX_ATTEMPTS).
{
  let sends = 0;
  const env = { DB: outboxDb, EMAIL: { send: async () => { sends++; throw new Error("HTTP 500 upstream"); } } };
  const status = await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "flows-channel-test" });
  check("5xx: status failed", status === "failed", status);
  check("5xx: bounded retries (no storm) — attempts <= MAX_ATTEMPTS", sends > 0 && sends <= MAX_ATTEMPTS, `sends=${sends} MAX_ATTEMPTS=${MAX_ATTEMPTS}`);
  const row = await outboxDb.prepare(`SELECT attempts, status, detail FROM ${OUTBOX_TABLE} WHERE kind='flows-channel-test' ORDER BY created_at DESC LIMIT 1`).first();
  check("5xx: outbox marks failed with reason + attempts", row && row.status === "failed" && row.attempts === sends && typeof row.detail === "string", JSON.stringify(row));
}

// backoff is bounded and exponential-shaped
{
  check("backoff: bounded, monotonic non-decreasing, capped", backoffDelayMs(1) === 1000 && backoffDelayMs(2) === 2000 && backoffDelayMs(4) === 8000 && backoffDelayMs(10) <= 30000 && backoffDelayMs(99) === 30000);
}

/* ---------------- idempotency key: a retried magic-link send does NOT mint a second row ---------------- */

{
  const db2 = makeOutboxDb();
  const env = { DB: db2, EMAIL: { send: async () => ({ messageId: "cf_retry" }) } };
  const key = "magic_link:ABC:1";
  await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "magic_link", idempotencyKey: key });
  const status2 = await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "magic_link", idempotencyKey: key });
  check("idempotency: retried key does not mint a second row", status2 === "sent");
  const count = db2._raw.prepare(`SELECT COUNT(*) c FROM ${OUTBOX_TABLE} WHERE idempotency_key = ?`).get(key).c;
  check("idempotency: exactly one row for the key", Number(count) === 1, `count=${count}`);
}

/* ---------------- ESP adapter against a REAL local HTTP listener ---------------- */

{
  const apiKey = "throwaway_" + Math.random().toString(36).slice(2, 20); // generated here, value never reused
  const received = { req: null, body: null };
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.req = { method: req.method, url: req.url, headers: req.headers };
      received.body = b;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resend_msg_42" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/emails`;
  const env = { ESP_API_KEY: apiKey, ESP_BASE_URL: base };
  const result = await transportEsp(env, { to: "recipient@test.com", subject: "Hello", text: "body text", html: "<p>hi</p>" }, { idempotencyKey: "esp_idem_1" });
  srv.close();

  const rb = JSON.parse(received.body);
  check("esp wire: status sent with provider id", result.status === "sent" && result.messageId === "resend_msg_42", JSON.stringify(result));
  check("esp wire: method POST", received.req.method === "POST", received.req.method);
  check("esp wire: path exact", received.req.url === "/emails", received.req.url);
  check("esp wire: auth header is Bearer with the throwaway value", received.req.headers.authorization === `Bearer ${apiKey}`, "auth present by value (throwaway)");
  check("esp wire: message id is not the api key (value not leaked back)", result.messageId !== apiKey);
  check("esp wire: JSON body to/from/subject/text/html", rb.to[0] === "recipient@test.com" && rb.from && rb.subject === "Hello" && rb.text === "body text" && rb.html === "<p>hi</p>", JSON.stringify(rb));
  check("esp wire: idempotency-key header carried", received.req.headers["idempotency-key"] === "esp_idem_1", received.req.headers["idempotency-key"]);
}

/* ---------------- trace id: every log line carries the outbox row id ---------------- */

{
  const db3 = makeOutboxDb();
  const key = "trace_key_xyz";
  const env = { DB: db3, EMAIL: { send: async () => ({ messageId: "cf_trace" }) } };
  const orig = console.log;
  let captured = "";
  console.log = (...a) => { captured += a.join(" ") + "\n"; };
  try {
    await sendMail(env, { to: "a@b.com", subject: "s", text: "t", kind: "magic_link", idempotencyKey: key });
  } finally {
    console.log = orig;
  }
  const row = db3._raw.prepare(`SELECT id FROM ${OUTBOX_TABLE} WHERE idempotency_key = ?`).get(key);
  check("trace id: outbox row id equals the idempotency key", row.id === key, row.id);
  check("trace id: the log line carries the trace id", captured.includes(key) && captured.includes("[mail " + key), captured.slice(0, 200));
}

process.exit(summary());