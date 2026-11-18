// dillo/src/mail/mail.mjs — the Dillo email primitive (P2, 2026-11-10).
//
// One self-contained ESM module (stdlib only, no imports) so any surface can
// consume it whole — the Reuse Law's shape for a build-time dependency: a
// copy with a name and a hash. Canonical home: dillo/src/mail/mail.mjs.
// Surfaces that bundle their own src/* modules (accounts, platform, flows)
// vendor this file verbatim (see the VENDOR note below) and re-export it.
//
// WHAT THIS IS:
//   1. render(template, vars) + renderTemplate(template, vars) — the 7 v1
//      templates (magic link, welcome, enrollment-key reveal notice,
//      email-change confirm, identity-link verify, Flows approval request,
//      Flows channel test), each a plain (vars) => { subject, text, html }
//      closure. All vars are HTML-escaped on interpolate; template syntax is
//      data, never code.
//   2. The outbox state machine — one row per message: queued -> sent /
//      failed / no_mailer, with provider message id. The outbox row id IS the
//      message's trace id (Scope Addendum 2 §3) and every log line this
//      module emits carries it.
//   3. Transport adapters: the Cloudflare send_email binding (env.EMAIL) and
//      a generic HTTPS ESP adapter (Resend-shaped, bearer token by name).
//
// SECURITY RULES (enforced, not advisory):
//   - template injection: a var is never interpolated as markup. Every value
//     passes escHtml / escAttr / escTextLink. Template names are a closed
//     vocabulary — an unknown name fails closed (no render, no send).
//   - header injection: subject is stripped of CR/LF; to is validated/refused
//     on CR/LF. No header is ever built by string concat from a var.
//   - oversized body: bounded at MAX_BODY_CHARS (named limit, fail closed).
//   - transport 5xx: -> outbox 'failed' with reason, bounded backoff, no
//     retry storm (MAX_ATTEMPTS + exponential base).
//   - idempotency: a caller-supplied idempotencyKey (or an outbox row id) is
//     the message trace id; a retried magic-link send with the same key does
//     NOT mint a second row (outbox id is dedupe; the magic token mint is the
//     CALLER's idempotency concern, documented).
//   - secrets by NAME only: ESP_API_KEY / ESP_BASE_URL / MAIL_FROM arrive via
//     env by reference; no value is ever written back to a body/text/html,
//     a log, or an error message.
//
// VENDOR note (the pin shape): a surface may copy this file verbatim into its
// own src/ tree under the name `dillo-mail.mjs` and re-export it, EXACTLY as
// the design-system canon is pinned (copy + name + hash). The hash below is
// this file's canonical identity; a vendored copy MUST be byte-identical —
// fix here and re-pin, never hand-edit a vendored copy.
//   sha256 of THIS file: recorded at build; mail_proof.mjs re-checks a vendored
//   copy's byte-identity against this home.

export const MAX_BODY_CHARS = 200_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 1000;
export const MAX_ATTEMPT_DELAY_MS = 30_000;

function htmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(s) {
  return htmlEscape(s).replace(/'/g, "&#39;");
}
// A URL rendered into href / link text: HTML-escaped, and whitespace/control
// chars are neutralized so no attribute or newline breakout is possible.
function escUrl(s) {
  return escAttr(String(s).replace(/[\r\n\s]+/g, " ").trim());
}
// Strip CR/LF from a single-line header value (subject / from). A header is
// never built by concatenation that could be split by a newline.
function headerSafe(s) {
  return String(s).replace(/[\r\n]+/g, " ").trim();
}

/* ---------------- templates (the 7 v1) ---------------- */

// Each template is { id, subject, text, html } all as pure functions of vars,
// because vars are data that must never run as markup. Every interpolated
// value is escaped at interpolation time.
const TEMPLATES = {
  "magic-link": {
    subject: () => "Your 29Court sign-in link",
    text: (v) => `Sign in to 29Court:\n\n${v.link}\n\nThis link works once and expires in 15 minutes. If you did not request it, ignore this email — no one can sign in without it.`,
    html: (v) => shell(v.heading, v.body, v.buttonLabel, v.link),
  },
  "welcome": {
    subject: () => "Welcome to 29Court",
    text: (v) => `${v.greeting}\n\n${v.body}\n\nGet started: ${v.link}`,
    html: (v) => shell(v.heading, v.body, v.buttonLabel, v.link),
  },
  "enrollment-key-reveal": {
    subject: () => "Your 29Court enrollment key",
    text: (v) => `Your enrollment key:\n\n${v.key}\n\nKeep it private — it links your school to your 29Court membership.`,
    html: (v) => shell(v.heading, `Your enrollment key is: ${v.key}. Keep it private — it links your school to your 29Court membership.`, v.buttonLabel, v.link),
  },
  "email-change-confirm": {
    subject: () => "Confirm your new 29Court sign-in email",
    text: (v) => `Confirm this as your new 29Court sign-in email:\n\n${v.link}\n\nThis link works once and expires in 15 minutes.`,
    html: (v) => shell(v.heading, v.body, v.buttonLabel, v.link),
  },
  "identity-link-verify": {
    subject: () => "Your 29Court identity-link code",
    text: (v) => `Use this code to link this email to your 29Court account:\n\n${v.code}\n\nIt works once and expires in 15 minutes. If you did not request it, ignore this email.`,
    html: (v) => shell(v.heading, `Your identity-link code is: ${v.code} — it works once and expires in 15 minutes. If you did not request it, ignore this email.`, v.buttonLabel, v.link),
  },
  "flows-approval-request": {
    subject: (v) => `Approval needed: ${headerSafe(v.flowName || "a flow")}`,
    text: (v) => `${v.prompt || "A flow run is waiting for your approval."}\n\nRequested by: ${v.requester || "a flow run"}\n\nApprove or decline: ${v.link}`,
    html: (v) => shell(v.heading || "Approval needed", v.prompt || "A flow run is waiting for your approval.", v.buttonLabel || "Review request", v.link),
  },
  "flows-channel-test": {
    subject: () => "Dillo Flows — your email channel works",
    text: () => "This is the Dillo Flows validation message. Your email channel just proved itself with a real send, so it is now live: flows in your space can send email through the built-in mailer.\n\nNothing else was sent, and nobody else got a copy.",
    html: (v) => shell(v.heading || "Your email channel works", "This is the Dillo Flows validation message. Your email channel just proved itself with a real send, so it is now live.", v.buttonLabel || "Back to Flows", v.link),
  },
};

// The house transactional shell, promoted from the accounts HITL house shell
// (mailer.js `houseEmailShell`). Table layout + inline styles, because email
// clients strip everything else. "29Court Liaison" masthead, warm bone
// background, white content surface, coral (#D94E26) reserved for the one
// primary action.
function shell(heading, body, buttonLabel, buttonUrl) {
  const b = htmlEscape(body);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5EFE3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE3;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border:1px solid #E2D6C0;border-radius:16px;">
<tr><td style="padding:28px 32px 0;">
<p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5C686E;">29Court Liaison</p>
<h1 style="margin:10px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;line-height:1.25;color:#1E2A30;">${htmlEscape(heading)}</h1>
</td></tr>
<tr><td style="padding:14px 32px 0;">
<p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#46535A;">${b}</p>
</td></tr>
<tr><td style="padding:22px 32px 4px;">
<a href="${escUrl(buttonUrl)}" style="display:inline-block;background:#D94E26;color:#FFFFFF;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:650;padding:12px 28px;border-radius:999px;">${htmlEscape(buttonLabel)}</a>
</td></tr>
<tr><td style="padding:18px 32px 28px;">
<p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5C686E;">If the button does not work, copy this link into your browser:<br><a href="${escUrl(buttonUrl)}" style="color:#2A7C71;word-break:break-all;">${escUrl(buttonUrl)}</a></p>
</td></tr>
</table>
<p style="margin:14px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#5C686E;">29Court · This message was sent because someone asked to sign in.</p>
</td></tr>
</table>
</body></html>`;
}

const KNOWN_TEMPLATES = Object.keys(TEMPLATES);

// renderTemplate(template, vars) — the strict entry. An unknown template name
// throws (fails closed); callers that want the "no send, fail closed" behavior
// catch and record.
export function renderTemplate(template, vars = {}) {
  const v = vars && typeof vars === "object" ? vars : {};
  if (!TEMPLATES[template]) {
    const e = new Error("unknown template");
    e.code = "unknown_template";
    throw e;
  }
  const t = TEMPLATES[template];
  const subject = headerSafe(t.subject(v));
  const text = t.text(v);
  const html = t.html(v);
  if (html.length > MAX_BODY_CHARS || text.length > MAX_BODY_CHARS) {
    const e = new Error("message body exceeds the bound");
    e.code = "oversized_body";
    throw e;
  }
  return { template, subject, text, html };
}

// render(template, vars) — alias, the name the plan/brief use.
export function render(template, vars) {
  return renderTemplate(template, vars);
}

// houseEmailShell({heading, body, buttonLabel, buttonUrl}) — the promoted
// house transactional shell, exported for back-compat with the accounts
// HITL callers while they move onto the template entry. Returns the html body.
export function houseEmailShell({ heading, body, buttonLabel, buttonUrl }) {
  return shell(heading, body, buttonLabel, buttonUrl);
}

export function listTemplates() {
  return KNOWN_TEMPLATES.slice();
}

/* ---------------- transports ---------------- */

// Cloudflare send_email binding adapter. Delivery targets are the account's
// verified Email Routing addresses (fact-check recorded in RUN.md).
export async function transportCloudflare(env, msg) {
  const binding = env && env.EMAIL;
  if (!binding || typeof binding.send !== "function") {
    return { status: "no_mailer", detail: null };
  }
  try {
    const from = env.MAIL_FROM || "accounts@dispatch.29court.com";
    const out = await binding.send({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    const messageId = out && (out.messageId || out.id) ? String(out.messageId || out.id) : null;
    return { status: "sent", messageId };
  } catch (e) {
    return { status: "failed", detail: String(e && e.message ? e.message : e).slice(0, 300) };
  }
}

// Generic HTTPS ESP adapter (Resend-shaped). Secrets arrive by NAME only via
// env (ESP_API_KEY, ESP_BASE_URL, ESP_FROM). Returns the provider id + status.
export async function transportEsp(env, msg, { idempotencyKey } = {}) {
  const key = env && env.ESP_API_KEY;
  const base = (env && env.ESP_BASE_URL) || "https://api.resend.com/emails";
  if (!key) {
    return { status: "no_mailer", detail: null };
  }
  const from = env.ESP_FROM || env.MAIL_FROM || "accounts@dispatch.29court.com";
  const body = {
    from,
    to: [msg.to],
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
  };
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
  if (idempotencyKey) headers["idempotency-key"] = String(idempotencyKey);
  let resp;
  try {
    resp = await fetch(base, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: "failed", detail: String(e && e.message ? e.message : e).slice(0, 300) };
  }
  try {
    const data = await resp.json();
    if (resp.ok) {
      return { status: "sent", messageId: data && data.id ? String(data.id) : null };
    }
    // 4xx is a permanent refuse -> failed, no retry worth the storm. 5xx too.
    return { status: "failed", detail: `esp ${resp.status}: ${(data && data.message) || (data && data.error) || ""} `.slice(0, 300) };
  } catch {
    await resp.body?.cancel().catch(() => {});
    return { status: "failed", detail: `esp ${resp.status}` };
  }
}

/* ---------------- outbox state machine ---------------- */

// The outbox row id IS the trace id. One row per message: queued -> sent /
// failed / no_mailer, with provider message id and bounded attempts.
export function newTraceId() {
  return `mail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Compute the bounded backoff delay for a retry attempt (1-based). Exponential
// with a cap — F-18's policy shape: no retry storm.
export function backoffDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(MAX_ATTEMPT_DELAY_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

// outboxSchema is the DDL this primitive owns (the promoted accounts outbox).
// The table lives in the ONE 29court D1 via db/migrations/0012-dillo-mail.json.
export const OUTBOX_TABLE = "dillo_mail_outbox";

export function outboxDdl() {
  return `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  kind          TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  from_email    TEXT,
  subject       TEXT,
  status        TEXT NOT NULL,
  provider_message_id TEXT,
  detail        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_kind ON ${OUTBOX_TABLE}(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_status ON ${OUTBOX_TABLE}(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_idem ON ${OUTBOX_TABLE}(idempotency_key);`;
}

function logline(traceId, event, extra = "") {
  return `[mail ${traceId}] ${event}${extra ? " " + extra : ""}`;
}

async function insertRow(env, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO ${OUTBOX_TABLE} (id, tenant_id, kind, to_email, from_email, subject, status, provider_message_id, detail, attempts, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.tenant_id ?? null, row.kind, row.to_email, row.from_email ?? null,
      row.subject ?? null, row.status, row.provider_message_id ?? null, row.detail ?? null,
      row.attempts ?? 0, row.idempotency_key ?? null, row.created_at, row.updated_at
    ).run();
  } catch {
    // the outbox is observability, not the request path — but never swallow a
    // send result into silence; the caller's status still returns truthfully.
  }
}

async function updateRow(env, id, patch) {
  try {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    // placeholder order: <patch cols...>, updated_at, id
    vals.push(Date.now());
    vals.push(id);
    await env.DB.prepare(
      `UPDATE ${OUTBOX_TABLE} SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`
    ).bind(...vals).run();
  } catch {
    /* observability only */
  }
}

async function findByIdempotency(env, key) {
  if (!key || !env.DB) return null;
  try {
    return await env.DB.prepare(
      `SELECT * FROM ${OUTBOX_TABLE} WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(String(key)).first();
  } catch {
    return null;
  }
}

// sendMail(env, opts) — the primitive's one send entry. Interface-compatible with
// the accounts house shell (to/subject/text/html/kind), plus optional
// tenant_id, idempotencyKey (the trace/dedupe id), and transport selection.
// Returns one of "sent" | "failed" | "no_mailer" and (on failure) records the
// bounded attempt. Does NOT throw for a transport failure — the status is the
// contract.
export async function sendMail(env, opts = {}) {
  const { to, subject, text, kind = "mail", html, tenant_id, idempotencyKey, transport } = opts;

  // header injection: to and subject are single-line; refuse CR/LF outright.
  if (typeof to !== "string" || /[\r\n]/.test(to) || !to.includes("@")) {
    const e = new Error("refused: invalid recipient");
    e.code = "header_injection";
    throw e;
  }
  const safeSubject = headerSafe(subject == null ? "" : subject);

  const traceId = idempotencyKey ? String(idempotencyKey) : newTraceId();
  const now = Date.now();

  if (env && env.DB) {
    const prior = await findByIdempotency(env, idempotencyKey);
    if (prior) {
      // idempotency: the same key already produced a row — no second send, no
      // second row. Hand back the recorded status.
      return prior.status;
    }
    await insertRow(env, {
      id: traceId, tenant_id: tenant_id ?? null, kind, to_email: to,
      subject: safeSubject, status: "queued", attempts: 0,
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      created_at: now, updated_at: now,
    });
  }

  // No mailer bound at all -> 'no_mailer', honestly reported, never silently
  // upgraded to 'sent'.
  const hasCf = env && env.EMAIL && typeof env.EMAIL.send === "function";
  const hasEsp = env && env.ESP_API_KEY;
  if (!hasCf && !hasEsp) {
    console.log(logline(traceId, "no_mailer", `kind=${kind} to=${to}`));
    if (env && env.DB) await updateRow(env, traceId, { status: "no_mailer" });
    return "no_mailer";
  }

  const useEsp = transport === "esp" || (hasEsp && !hasCf);
  let attempt = 0;
  let result;
  // bounded retries: attempt up to MAX_ATTEMPTS with exponential backoff when
  // the transport reports a transient (5xx-class) failure. A 4xx / header
  // refusal is permanent — no retry.
  for (; attempt < MAX_ATTEMPTS; attempt++) {
    result = useEsp
      ? await transportEsp(env, { to, subject: safeSubject, text, html, kind }, { idempotencyKey: traceId })
      : await transportCloudflare(env, { to, subject: safeSubject, text, html, kind });

    if (result.status === "sent") break;
    // Only retry on a transport-level transient failure (5xx detail marker),
    // never on a permanent refusal. The Cloudflare binding throws -> 'failed'
    // with detail; a bounded retry there is still bounded by MAX_ATTEMPTS.
    const permanent = typeof result.detail === "string" && !/5\d\d|esp 5/.test(result.detail);
    if (result.detail == null || permanent) break;
    if (attempt + 1 < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, backoffDelayMs(attempt + 1)));
    }
  }
  const attemptsMade = Math.min(attempt + 1, MAX_ATTEMPTS);

  const finalStatus = result.status;
  if (env && env.DB) {
    await updateRow(env, traceId, {
      status: finalStatus,
      provider_message_id: result.messageId ?? null,
      detail: result.detail ?? null,
      attempts: attemptsMade,
    });
  }
  console.log(logline(traceId, finalStatus, `kind=${kind} to=${to} attempts=${attemptsMade}${result.messageId ? " provider=" + result.messageId : ""}${result.detail ? " " + result.detail.slice(0, 120) : ""}`));
  return finalStatus;
}