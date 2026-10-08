import { HTTP_API_PREFIX, REALTIME_PROTOCOL } from "./versions.js";
import {
  isRealtimeChannel,
  matchesRealtimeWhere,
  serializeRealtimeMessage,
  type RealtimeEvent,
  type RealtimeServerMessage,
  type RealtimeSubscription,
} from "./realtime.js";

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

interface ActiveSubscription<TRecord = Record<string, unknown>> {
  id: string;
  channel: string;
  where?: Record<string, unknown>;
  onChange(event: RealtimeEvent<TRecord>): void;
  errors: Set<(error: Error) => void>;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function defaultFactory(url: string, protocols: string[]): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new TypeError("Realtime subscriptions need a WebSocket implementation in this environment.");
  }
  return new WebSocket(url, protocols);
}

/** One reconnecting WebSocket shared by every table and custom-channel subscription. */
export class RealtimeClient {
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly factory: WebSocketFactory;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private intentionallyClosed = false;
  private authorizedChannels = new Set<string>();

  constructor(private readonly options: RealtimeClientOptions) {
    this.factory = options.webSocket ?? defaultFactory;
  }

  subscribe<TRecord extends Record<string, unknown>>(
    options: SubscribeOptions<TRecord>,
  ): RealtimeSubscription<TRecord> {
    if (!isRealtimeChannel(options.channel)) throw new TypeError(`Realtime channel \`${options.channel}\` is invalid.`);
    const id = `sub_${crypto.randomUUID()}`;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const active: ActiveSubscription<TRecord> = {
      id,
      channel: options.channel,
      ...(options.where ? { where: options.where as Record<string, unknown> } : {}),
      onChange: options.onChange,
      errors: new Set(),
      ready,
      resolveReady,
      rejectReady,
    };
    this.subscriptions.set(id, active as ActiveSubscription);
    this.intentionallyClosed = false;
    if (this.socket && !this.authorizedChannels.has(options.channel)) {
      this.socket.close(1012, "Authorizing a new channel");
      return {
        id,
        channel: options.channel,
        ready,
        unsubscribe: () => this.unsubscribe(id),
        onError: (listener) => {
          active.errors.add(listener);
          return () => active.errors.delete(listener);
        },
      };
    }
    this.connect();
    if (this.socket?.readyState === 1) this.sendSubscribe(active);
    return {
      id,
      channel: options.channel,
      ready,
      unsubscribe: () => this.unsubscribe(id),
      onError: (listener) => {
        active.errors.add(listener);
        return () => active.errors.delete(listener);
      },
    };
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.socket?.close(1000, "Client closed");
    this.socket = undefined;
  }

  private connect(): void {
    if (this.socket || this.subscriptions.size === 0) return;
    const endpoint = this.options.realtimeUrl
      ? new URL(this.options.realtimeUrl)
      : new URL(`${HTTP_API_PREFIX}/realtime/connect`, this.options.url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    if (this.options.namespace) endpoint.searchParams.set("appId", this.options.namespace);
    if (this.options.clientAppId) endpoint.searchParams.set("clientAppId", this.options.clientAppId);
    if (this.options.clientKey) endpoint.searchParams.set("clientKey", this.options.clientKey);
    this.authorizedChannels = new Set([...this.subscriptions.values()].map((subscription) => subscription.channel));
    for (const channel of this.authorizedChannels) {
      endpoint.searchParams.append("channel", channel);
    }
    endpoint.searchParams.set("channels", [...this.authorizedChannels].join(","));
    const credential = this.options.credential();
    const protocols = [REALTIME_PROTOCOL, ...(credential ? [`credential.${base64Url(credential)}`] : [])];
    try {
      const socket = this.factory(endpoint.toString(), protocols);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === 1) {
            socket.send(serializeRealtimeMessage({ type: "heartbeat", timestamp: Date.now() }));
          }
        }, 30_000);
        for (const subscription of this.subscriptions.values()) this.sendSubscribe(subscription);
      });
      socket.addEventListener("message", (event) => this.onMessage(event as MessageEvent));
      socket.addEventListener("error", () => this.notifyAll(new Error("Realtime WebSocket failed.")));
      socket.addEventListener("close", () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        if (this.socket === socket) this.socket = undefined;
        if (!this.intentionallyClosed && this.subscriptions.size > 0) this.scheduleReconnect();
      });
    } catch (error) {
      this.notifyAll(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const minimum = this.options.minimumReconnectMs ?? 500;
    const maximum = this.options.maximumReconnectMs ?? 30_000;
    const delay = Math.min(maximum, minimum * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private sendSubscribe(subscription: ActiveSubscription): void {
    this.socket?.send(serializeRealtimeMessage({
      type: "subscribe",
      id: subscription.id,
      channel: subscription.channel,
      ...(subscription.where ? { where: subscription.where } : {}),
    }));
  }

  private unsubscribe(id: string): void {
    if (!this.subscriptions.delete(id)) return;
    if (this.socket?.readyState === 1) {
      this.socket.send(serializeRealtimeMessage({ type: "unsubscribe", id }));
    }
    if (this.subscriptions.size === 0) this.close();
  }

  private onMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(String(event.data)) as RealtimeServerMessage;
      if (message.type === "heartbeat") {
        this.socket?.send(serializeRealtimeMessage({ type: "heartbeat", timestamp: message.timestamp }));
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.message);
        if (message.id) this.notify(this.subscriptions.get(message.id), error);
        else this.notifyAll(error);
        return;
      }
      const subscription = this.subscriptions.get(message.id);
      if (!subscription) return;
      if (message.type === "subscribed") subscription.resolveReady();
      if (message.type === "change" && matchesRealtimeWhere(
        message.event.record as Record<string, unknown>,
        subscription.where,
      )) {
        subscription.onChange(message.event);
      }
    } catch (error) {
      this.notifyAll(error instanceof Error ? error : new Error("Realtime server sent an invalid message."));
    }
  }

  private notify(subscription: ActiveSubscription | undefined, error: Error): void {
    if (!subscription) return;
    subscription.rejectReady(error);
    for (const listener of subscription.errors) listener(error);
  }

  private notifyAll(error: Error): void {
    for (const subscription of this.subscriptions.values()) this.notify(subscription, error);
  }
}
