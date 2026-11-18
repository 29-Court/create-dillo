import {
  CLAIM_TICKET_DEFAULT_TTL_SECONDS,
  CLAIM_TICKET_MAX_TTL_SECONDS,
  CLAIM_TICKET_MIN_TTL_SECONDS,
  type AgentBridgeIntent,
  type ClaimTicket,
  type CreateTicketInput,
  type EnrollInput,
  type Enrollment,
  type InboxItem,
  type IntentJob,
  type ScopedCredential,
  type SubmitIntentInput,
  isAgentBridgeConnector,
  isAgentBridgeIntent,
} from "./types.js";
import { addSecondsIso, makeId, nowIso, randomToken, sha256Hex } from "./crypto.js";

export class AgentBridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AgentBridgeError";
    this.status = status;
    this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}

export interface AgentBridgeStore {
  createTicket(input: CreateTicketInput): Promise<{ ticket: ClaimTicket; token: string }>;
  getTicketByToken(appId: string, token: string): Promise<ClaimTicket | null>;
  enroll(input: EnrollInput): Promise<{ enrollment: Enrollment; credential: ScopedCredential }>;
  resolveCredential(appId: string, secret: string): Promise<Enrollment | null>;
  submitIntent(input: SubmitIntentInput): Promise<IntentJob>;
  listInbox(appId: string, enrollmentId: string, options?: { limit?: number; after?: string }): Promise<InboxItem[]>;
  ackInbox(appId: string, enrollmentId: string, itemId: string): Promise<InboxItem>;
}

function normalizeAgentId(value: string): string {
  const agentId = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._:-]{1,63}$/.test(agentId)) {
    throw new AgentBridgeError(422, "VALIDATION_ERROR", "agentId is invalid.", {
      agentId: "Use 2–64 chars: letter start, then letters/digits/._:-",
    });
  }
  return agentId;
}



function ttlSeconds(value: number | undefined): number {
  const ttl = value ?? CLAIM_TICKET_DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < CLAIM_TICKET_MIN_TTL_SECONDS || ttl > CLAIM_TICKET_MAX_TTL_SECONDS) {
    throw new AgentBridgeError(422, "VALIDATION_ERROR", "ttlSeconds is invalid.", {
      ttlSeconds: `Use an integer from ${CLAIM_TICKET_MIN_TTL_SECONDS} to ${CLAIM_TICKET_MAX_TTL_SECONDS} (default ${CLAIM_TICKET_DEFAULT_TTL_SECONDS})`,
    });
  }
  return ttl;
}

function normalizeIntent(value: unknown): AgentBridgeIntent {
  if (!isAgentBridgeIntent(value)) {
    throw new AgentBridgeError(422, "VALIDATION_ERROR", "intent is invalid.", {
      intent: "Use an allowlisted intent such as bridge_enroll_v0",
    });
  }
  return value;
}

function refreshTicketStatus(ticket: ClaimTicket, now = nowIso()): ClaimTicket {
  if (ticket.status === "pending" && ticket.expiresAt <= now) {
    return { ...ticket, status: "expired" };
  }
  return ticket;
}

/** In-memory store for local/sandbox tests. Not for multi-process prod. */
export class MemoryAgentBridgeStore implements AgentBridgeStore {
  private readonly tickets = new Map<string, ClaimTicket>();
  private readonly ticketByHash = new Map<string, string>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly credByHash = new Map<string, string>();
  private readonly jobs = new Map<string, IntentJob>();
  private readonly inbox = new Map<string, InboxItem>();

  async createTicket(input: CreateTicketInput): Promise<{ ticket: ClaimTicket; token: string }> {
    const agentId = normalizeAgentId(input.agentId);
    const intent = normalizeIntent(input.intent as unknown);
    const hint = input.connectorHint ?? null;
    if (hint !== null && !isAgentBridgeConnector(hint)) {
      throw new AgentBridgeError(422, "VALIDATION_ERROR", "connectorHint is invalid.");
    }
    const token = `abt_${randomToken(24)}`;
    const tokenHash = await sha256Hex(token);
    const createdAt = nowIso();
    const ticket: ClaimTicket = {
      id: makeId("abtkt"),
      appId: input.appId,
      ownerId: input.ownerId,
      agentId,
      intent,
      connectorHint: hint,
      tokenHash,
      status: "pending",
      expiresAt: addSecondsIso(ttlSeconds(input.ttlSeconds)),
      consumedAt: null,
      createdAt,
    };
    this.tickets.set(ticket.id, ticket);
    this.ticketByHash.set(`${input.appId}:${tokenHash}`, ticket.id);
    return { ticket, token };
  }

  async getTicketByToken(appId: string, token: string): Promise<ClaimTicket | null> {
    const tokenHash = await sha256Hex(token.trim());
    const id = this.ticketByHash.get(`${appId}:${tokenHash}`);
    if (!id) return null;
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    const refreshed = refreshTicketStatus(ticket);
    if (refreshed !== ticket) this.tickets.set(id, refreshed);
    return refreshed;
  }

  async enroll(input: EnrollInput): Promise<{ enrollment: Enrollment; credential: ScopedCredential }> {
    if (!isAgentBridgeConnector(input.connector)) {
      throw new AgentBridgeError(422, "VALIDATION_ERROR", "connector is invalid.", {
        connector: "Use muse-poll, grok-webhook, or generic-manual",
      });
    }
    const agentId = normalizeAgentId(input.agentId);
    const intent = normalizeIntent(input.intent);
    const ticket = await this.getTicketByToken(input.appId, input.token);
    // Uniform client error for invalid/expired/consumed/mismatch (no oracle leakage).
    const reject = () => {
      throw new AgentBridgeError(400, "BAD_REQUEST", "Claim ticket cannot be redeemed.");
    };
    if (!ticket) reject();
    const claim = ticket!;
    if (claim.ownerId !== input.ownerId) {
      throw new AgentBridgeError(403, "FORBIDDEN", "Only the ticket owner may approve enrollment.");
    }
    if (claim.status === "expired" || claim.status === "consumed") reject();
    if (claim.agentId !== agentId || claim.intent !== intent) reject();
    if (claim.connectorHint && claim.connectorHint !== input.connector) {
      throw new AgentBridgeError(422, "VALIDATION_ERROR", "connector does not match ticket hint.", {
        connector: `Ticket requires ${claim.connectorHint}`,
      });
    }

    const secret = `abr_${randomToken(32)}`;
    const credentialId = makeId("abcred");
    const prefix = secret.slice(0, 18);
    const createdAt = nowIso();
    const enrollment: Enrollment = {
      id: makeId("abenroll"),
      appId: input.appId,
      ownerId: input.ownerId,
      agentId,
      intent,
      connector: input.connector,
      credentialId,
      credentialPrefix: prefix,
      status: "active",
      ticketId: claim.id,
      createdAt,
      revokedAt: null,
    };

    claim.status = "consumed";
    claim.consumedAt = createdAt;
    this.tickets.set(claim.id, claim);
    this.enrollments.set(enrollment.id, enrollment);
    this.credByHash.set(`${input.appId}:${await sha256Hex(secret)}`, enrollment.id);

    const credential: ScopedCredential = {
      secret,
      credentialId,
      prefix,
      scopes: ["bridge:intents", "bridge:inbox", `bridge:agent:${agentId}`],
      expiresAt: null,
    };
    return { enrollment, credential };
  }

  async resolveCredential(appId: string, secret: string): Promise<Enrollment | null> {
    const id = this.credByHash.get(`${appId}:${await sha256Hex(secret.trim())}`);
    if (!id) return null;
    const enrollment = this.enrollments.get(id);
    if (!enrollment || enrollment.status !== "active") return null;
    return enrollment;
  }

  async submitIntent(input: SubmitIntentInput): Promise<IntentJob> {
    const type = input.type.trim();
    if (type.length < 1 || type.length > 80) {
      throw new AgentBridgeError(422, "VALIDATION_ERROR", "intent type is invalid.", {
        type: "Use 1 to 80 characters",
      });
    }
    const enrollment = this.enrollments.get(input.enrollmentId);
    if (!enrollment || enrollment.appId !== input.appId || enrollment.status !== "active") {
      throw new AgentBridgeError(404, "NOT_FOUND", "Enrollment not found.");
    }
    if (enrollment.agentId !== input.agentId) {
      throw new AgentBridgeError(403, "FORBIDDEN", "Credential is not bound to this agent.");
    }
    const createdAt = nowIso();
    const job: IntentJob = {
      id: makeId("abjob"),
      appId: input.appId,
      enrollmentId: enrollment.id,
      agentId: enrollment.agentId,
      type,
      payload: JSON.stringify(input.payload ?? {}),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    this.jobs.set(job.id, job);

    const inboxStatus =
      enrollment.connector === "grok-webhook"
        ? "webhook_queued"
        : enrollment.connector === "generic-manual"
          ? "pending"
          : "pending";

    const item: InboxItem = {
      id: makeId("abinbox"),
      appId: input.appId,
      enrollmentId: enrollment.id,
      jobId: job.id,
      kind: "intent_accepted",
      body: JSON.stringify({
        job_id: job.id,
        type: job.type,
        connector: enrollment.connector,
        // Bounds: never fan out live webhooks; grok-webhook only queues locally.
        delivery: enrollment.connector === "grok-webhook" ? "local-queue-only" : enrollment.connector,
      }),
      status: inboxStatus,
      createdAt,
      ackedAt: null,
    };
    this.inbox.set(item.id, item);
    return job;
  }

  async listInbox(
    appId: string,
    enrollmentId: string,
    options: { limit?: number; after?: string } = {},
  ): Promise<InboxItem[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = [...this.inbox.values()]
      .filter((item) => item.appId === appId && item.enrollmentId === enrollmentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const start = options.after ? rows.findIndex((item) => item.id === options.after) + 1 : 0;
    const slice = start < 0 ? rows.slice(0, limit) : rows.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    return slice;
  }

  async ackInbox(appId: string, enrollmentId: string, itemId: string): Promise<InboxItem> {
    const item = this.inbox.get(itemId);
    if (!item || item.appId !== appId || item.enrollmentId !== enrollmentId) {
      throw new AgentBridgeError(404, "NOT_FOUND", "Inbox item not found.");
    }
    const updated: InboxItem = { ...item, status: "acked", ackedAt: nowIso() };
    this.inbox.set(itemId, updated);
    return updated;
  }
}
