export type RealtimeEventType = "created" | "updated" | "deleted" | "event";
export interface RealtimeEvent<TRecord = Record<string, unknown>> {
    type: RealtimeEventType;
    channel: string;
    table?: string;
    record: TRecord;
    timestamp: string;
    event?: string;
}
export interface RealtimeSubscription<TRecord = Record<string, unknown>> {
    /** @internal Type-only marker for the subscribed record. */
    readonly recordType?: TRecord;
    readonly id: string;
    readonly channel: string;
    unsubscribe(): void;
    onError(listener: (error: Error) => void): () => void;
    /** Resolves after the server has acknowledged the subscription. */
    readonly ready: Promise<void>;
}
export interface RealtimeAuthorizeContext {
    appId: string;
    channel: string;
    user: {
        id: string;
        email: string;
        name: string | null;
    };
    request: Request;
}
export interface RealtimeConfig {
    /** Explicit custom channels. Table subscriptions use `table:<TableName>`. */
    channels?: readonly string[];
    authorize?(context: RealtimeAuthorizeContext): boolean | Promise<boolean>;
}
export type RealtimeClientMessage = {
    type: "subscribe";
    id: string;
    channel: string;
    where?: Record<string, unknown>;
} | {
    type: "unsubscribe";
    id: string;
} | {
    type: "heartbeat";
    timestamp: number;
};
export type RealtimeServerMessage<T = Record<string, unknown>> = {
    type: "subscribed";
    id: string;
    channel: string;
} | {
    type: "unsubscribed";
    id: string;
} | {
    type: "change";
    id: string;
    event: RealtimeEvent<T>;
} | {
    type: "error";
    id?: string;
    message: string;
} | {
    type: "heartbeat";
    timestamp: number;
};
export declare function isRealtimeChannel(value: string): boolean;
export declare function serializeRealtimeMessage(message: RealtimeClientMessage | RealtimeServerMessage): string;
export declare function matchesRealtimeWhere(record: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean;
