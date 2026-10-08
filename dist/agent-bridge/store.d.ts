import { type ClaimTicket, type CreateTicketInput, type EnrollInput, type Enrollment, type InboxItem, type IntentJob, type ScopedCredential, type SubmitIntentInput } from "./types.js";
export declare class AgentBridgeError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fields?: Record<string, string>;
    constructor(status: number, code: string, message: string, fields?: Record<string, string>);
}
export interface AgentBridgeStore {
    createTicket(input: CreateTicketInput): Promise<{
        ticket: ClaimTicket;
        token: string;
    }>;
    getTicketByToken(appId: string, token: string): Promise<ClaimTicket | null>;
    enroll(input: EnrollInput): Promise<{
        enrollment: Enrollment;
        credential: ScopedCredential;
    }>;
    resolveCredential(appId: string, secret: string): Promise<Enrollment | null>;
    submitIntent(input: SubmitIntentInput): Promise<IntentJob>;
    listInbox(appId: string, enrollmentId: string, options?: {
        limit?: number;
        after?: string;
    }): Promise<InboxItem[]>;
    ackInbox(appId: string, enrollmentId: string, itemId: string): Promise<InboxItem>;
}
/** In-memory store for local/sandbox tests. Not for multi-process prod. */
export declare class MemoryAgentBridgeStore implements AgentBridgeStore {
    private readonly tickets;
    private readonly ticketByHash;
    private readonly enrollments;
    private readonly credByHash;
    private readonly jobs;
    private readonly inbox;
    createTicket(input: CreateTicketInput): Promise<{
        ticket: ClaimTicket;
        token: string;
    }>;
    getTicketByToken(appId: string, token: string): Promise<ClaimTicket | null>;
    enroll(input: EnrollInput): Promise<{
        enrollment: Enrollment;
        credential: ScopedCredential;
    }>;
    resolveCredential(appId: string, secret: string): Promise<Enrollment | null>;
    submitIntent(input: SubmitIntentInput): Promise<IntentJob>;
    listInbox(appId: string, enrollmentId: string, options?: {
        limit?: number;
        after?: string;
    }): Promise<InboxItem[]>;
    ackInbox(appId: string, enrollmentId: string, itemId: string): Promise<InboxItem>;
}
