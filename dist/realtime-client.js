import { HTTP_API_PREFIX, REALTIME_PROTOCOL } from "./versions.js";
import {
  isRealtimeChannel,
  matchesRealtimeWhere,
  serializeRealtimeMessage
} from "./realtime.js";
function base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function defaultFactory(url, protocols) {
  if (typeof WebSocket === "undefined") {
    throw new TypeError("Realtime subscriptions need a WebSocket implementation in this environment.");
  }
  return new WebSocket(url, protocols);
}
class RealtimeClient {
  constructor(options) {
    this.options = options;
    this.factory = options.webSocket ?? defaultFactory;
  }
  options;
  subscriptions = /* @__PURE__ */ new Map();
  factory;
  socket;
  reconnectTimer;
  heartbeatTimer;
  reconnectAttempts = 0;
  intentionallyClosed = false;
  authorizedChannels = /* @__PURE__ */ new Set();
  subscribe(options) {
    if (!isRealtimeChannel(options.channel)) throw new TypeError(`Realtime channel \`${options.channel}\` is invalid.`);
    const id = `sub_${crypto.randomUUID()}`;
    let resolveReady = () => {
    };
    let rejectReady = () => {
    };
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const active = {
      id,
      channel: options.channel,
      ...options.where ? { where: options.where } : {},
      onChange: options.onChange,
      errors: /* @__PURE__ */ new Set(),
      ready,
      resolveReady,
      rejectReady
    };
    this.subscriptions.set(id, active);
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
        }
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
      }
    };
  }
  close() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = void 0;
    this.heartbeatTimer = void 0;
    this.socket?.close(1e3, "Client closed");
    this.socket = void 0;
  }
  connect() {
    if (this.socket || this.subscriptions.size === 0) return;
    const endpoint = this.options.realtimeUrl ? new URL(this.options.realtimeUrl) : new URL(`${HTTP_API_PREFIX}/realtime/connect`, this.options.url);
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
    const protocols = [REALTIME_PROTOCOL, ...credential ? [`credential.${base64Url(credential)}`] : []];
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
        }, 3e4);
        for (const subscription of this.subscriptions.values()) this.sendSubscribe(subscription);
      });
      socket.addEventListener("message", (event) => this.onMessage(event));
      socket.addEventListener("error", () => this.notifyAll(new Error("Realtime WebSocket failed.")));
      socket.addEventListener("close", () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = void 0;
        if (this.socket === socket) this.socket = void 0;
        if (!this.intentionallyClosed && this.subscriptions.size > 0) this.scheduleReconnect();
      });
    } catch (error) {
      this.notifyAll(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const minimum = this.options.minimumReconnectMs ?? 500;
    const maximum = this.options.maximumReconnectMs ?? 3e4;
    const delay = Math.min(maximum, minimum * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      this.connect();
    }, delay);
  }
  sendSubscribe(subscription) {
    this.socket?.send(serializeRealtimeMessage({
      type: "subscribe",
      id: subscription.id,
      channel: subscription.channel,
      ...subscription.where ? { where: subscription.where } : {}
    }));
  }
  unsubscribe(id) {
    if (!this.subscriptions.delete(id)) return;
    if (this.socket?.readyState === 1) {
      this.socket.send(serializeRealtimeMessage({ type: "unsubscribe", id }));
    }
    if (this.subscriptions.size === 0) this.close();
  }
  onMessage(event) {
    try {
      const message = JSON.parse(String(event.data));
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
        message.event.record,
        subscription.where
      )) {
        subscription.onChange(message.event);
      }
    } catch (error) {
      this.notifyAll(error instanceof Error ? error : new Error("Realtime server sent an invalid message."));
    }
  }
  notify(subscription, error) {
    if (!subscription) return;
    subscription.rejectReady(error);
    for (const listener of subscription.errors) listener(error);
  }
  notifyAll(error) {
    for (const subscription of this.subscriptions.values()) this.notify(subscription, error);
  }
}
export {
  RealtimeClient
};
