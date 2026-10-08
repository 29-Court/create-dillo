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
export interface MailDelivery {
    send(job: SendMailJob): Promise<void>;
}
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
/**
 * A deliberately small, table-based email shell. It renders predictably in
 * Gmail, Outlook, and Apple Mail, and keeps every staff email visually alike.
 */
export declare function renderTransactionalEmail(message: TransactionalEmail): {
    html: string;
    text: string;
};
/** Deliver one queued job. Throwing signals a retryable provider failure; `consumeMailQueue` owns the attempt budget and terminal status. */
export declare function deliverMail(job: SendMailJob, env: MailProviderBindings): Promise<void>;
