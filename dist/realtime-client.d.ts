import { type RealtimeEvent, type RealtimeSubscription } from "./realtime.js";
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "close" | "error" | "message", listener: (event: Event | MessageEvent) => void): void;
}
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;
export interface RealtimeClientOptions {
    url: string;
    realtimeUrl?: string;
    /** Only supplied when the caller opted into registered-app policy. */
    clientAppId?: string;
    namespace?: string;
    clientKey?: string;
    credential: () => string | null;
    webSocket?: WebSocketFactory;
    minimumReconnectMs?: number;
    maximumReconnectMs?: number;
}
export interface SubscribeOptions<TRecord> {
    channel: string;
    where?: Partial<TRecord>;
    onChange(event: RealtimeEvent<TRecord>): void;
}
/** One reconnecting WebSocket shared by every table and custom-channel subscription. */
export declare class RealtimeClient {
    private readonly options;
    private readonly subscriptions;
    private readonly factory;
    private socket;
    private reconnectTimer;
    private heartbeatTimer;
    private reconnectAttempts;
    private intentionallyClosed;
    private authorizedChannels;
    constructor(options: RealtimeClientOptions);
    subscribe<TRecord extends Record<string, unknown>>(options: SubscribeOptions<TRecord>): RealtimeSubscription<TRecord>;
    close(): void;
    private connect;
    private scheduleReconnect;
    private sendSubscribe;
    private unsubscribe;
    private onMessage;
    private notify;
    private notifyAll;
}
