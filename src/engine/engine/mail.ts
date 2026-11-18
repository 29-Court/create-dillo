/** A durable, provider-neutral mail job carried by a Cloudflare Queue. */
export interface SendMailJob {
  version: 1;
  id: string;
  appId: string;
  kind: "magic_link";
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  createdAt: string;
}

export interface MailProviderBindings {
  /** A user-owned delivery component. Throw to signal a retryable failure. */
  ARMADILLO_MAIL_DELIVERY?: MailDelivery;
  RESEND_API_KEY?: string;
  ARMADILLO_MAIL_WEBHOOK?: string;
  ARMADILLO_MAIL_WEBHOOK_TOKEN?: string;
  ARMADILLO_DEV_MODE?: string;
  /** Second opt-in required before a message body is written to a log. */
  ARMADILLO_EXPOSE_DEBUG_TOKENS?: string;
  /** Cloudflare Email Sending API credentials, bound as Worker secrets. */
  CF_EMAIL_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export interface MailDelivery { send(job: SendMailJob): Promise<void> }

export type TransactionalEmail = {
  appName?: string;
  accentColor?: string;
  eyebrow?: string;
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  detail?: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function safeAccentColor(value: string | undefined): string {
  return /^#[0-9a-f]{6}$/iu.test(value?.trim() ?? "") ? value!.trim() : "#176c48";
}

/**
 * A deliberately small, table-based email shell. It renders predictably in
 * Gmail, Outlook, and Apple Mail, and keeps every staff email visually alike.
 */
export function renderTransactionalEmail(message: TransactionalEmail): { html: string; text: string } {
  const appName = message.appName?.trim() || "Armadillo";
  const accentColor = safeAccentColor(message.accentColor);
  const eyebrow = message.eyebrow?.trim() || "Staff access";
  const detail = message.detail?.trim();
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f7f4;color:#183128;font-family:Arial,sans-serif;"><span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(message.intro)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f7f4;"><tr><td align="center" style="padding:36px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #dfe9e1;border-radius:18px;overflow:hidden;"><tr><td style="padding:25px 32px;background:${accentColor};color:#ffffff;"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:.8;">${escapeHtml(eyebrow)}</div><div style="margin-top:7px;font-family:Georgia,serif;font-size:28px;font-weight:700;line-height:1.15;">${escapeHtml(appName)}</div></td></tr><tr><td style="padding:32px;"><h1 style="margin:0 0 14px;color:#183128;font-family:Georgia,serif;font-size:28px;line-height:1.18;">${escapeHtml(message.heading)}</h1><p style="margin:0;color:#52675b;font-size:16px;line-height:1.55;">${escapeHtml(message.intro)}</p><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:25px 0 21px;"><tr><td style="border-radius:9px;background:${accentColor};"><a href="${escapeHtml(message.ctaUrl)}" style="display:inline-block;padding:13px 19px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${escapeHtml(message.ctaLabel)}</a></td></tr></table>${detail ? `<p style="margin:0;padding:13px 15px;color:#5b6b62;background:#f2f7f3;border-radius:9px;font-size:13px;line-height:1.5;">${escapeHtml(detail)}</p>` : ""}<p style="margin:25px 0 0;color:#77877e;font-size:12px;line-height:1.5;">If you did not expect this email, you can safely ignore it.</p></td></tr></table><p style="margin:18px 0 0;color:#829087;font-size:12px;line-height:1.5;text-align:center;">${escapeHtml(appName)} · secure staff access</p></td></tr></table></body></html>`;
  const text = [
    appName,
    "",
    message.heading,
    message.intro,
    "",
    `${message.ctaLabel}: ${message.ctaUrl}`,
    ...(detail ? ["", detail] : []),
    "",
    "If you did not expect this email, you can safely ignore it.",
  ].join("\n");
  return { html, text };
}

async function checkDelivery(response: Response): Promise<void> {
  // Provider error bodies can echo recipients, credentials or magic links.
  // Do not retain them in the database or buffer an unbounded response.
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`Mail provider returned ${response.status}.`);
}

/** Deliver one queued job. Throwing signals a retryable provider failure; `consumeMailQueue` owns the attempt budget and terminal status. */
export async function deliverMail(job: SendMailJob, env: MailProviderBindings): Promise<void> {
  if (env.ARMADILLO_MAIL_DELIVERY) return env.ARMADILLO_MAIL_DELIVERY.send(job);
  if (env.CF_EMAIL_API_TOKEN?.trim() && env.CF_ACCOUNT_ID?.trim()) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID.trim())}/email/sending/send`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
        headers: {
          authorization: `Bearer ${env.CF_EMAIL_API_TOKEN.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: job.from,
          to: job.to,
          subject: job.subject,
          text: job.text,
          html: job.html,
        }),
      },
    );
    await checkDelivery(response);
    return;
  }

  if (env.RESEND_API_KEY?.trim()) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
        "content-type": "application/json",
        "idempotency-key": job.id,
      },
      body: JSON.stringify({
        from: job.from,
        to: [job.to],
        subject: job.subject,
        text: job.text,
        html: job.html,
      }),
    });
    await checkDelivery(response);
    return;
  }

  if (env.ARMADILLO_MAIL_WEBHOOK?.trim()) {
    const headers = new Headers({
      "content-type": "application/json",
      "idempotency-key": job.id,
    });
    if (env.ARMADILLO_MAIL_WEBHOOK_TOKEN?.trim()) {
      headers.set("authorization", `Bearer ${env.ARMADILLO_MAIL_WEBHOOK_TOKEN.trim()}`);
    }
    // The body carries the live magic-link URL, so this destination is a
    // credential transport. Require TLS rather than trusting an operator's
    // string: an `http://` value silently ships working sign-in tokens in
    // cleartext.
    const mailWebhook = new URL(env.ARMADILLO_MAIL_WEBHOOK.trim());
    if (mailWebhook.protocol !== "https:") {
      throw new Error("ARMADILLO_MAIL_WEBHOOK must use HTTPS: it carries sign-in links.");
    }
    const response = await fetch(mailWebhook, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      headers,
      body: JSON.stringify(job),
    });
    await checkDelivery(response);
    return;
  }

  // `text` embeds the live magic link, so logging it takes the same second
  // opt-in as returning one in a response body.
  if (env.ARMADILLO_DEV_MODE === "1" && env.ARMADILLO_EXPOSE_DEBUG_TOKENS === "1") {
    console.info("Armadillo development mail", {
      id: job.id,
      kind: job.kind,
      to: job.to,
      subject: job.subject,
      text: job.text,
    });
    return;
  }

  throw new Error("Configure RESEND_API_KEY or ARMADILLO_MAIL_WEBHOOK before consuming mail jobs.");
}
