type Response = import("@cloudflare/workers-types").Response;
declare const Response: typeof import("@cloudflare/workers-types").Response;
import type { D1Database, DurableObjectState, WebSocket } from "@cloudflare/workers-types";
import { serializeRealtimeMessage } from "../index.js";
export declare class ArmadilloRealtime {
    private readonly state;
    private readonly env;
    constructor(state: DurableObjectState, env: {
        DB?: D1Database;
    });
    private revalidate;
    fetch(request: import("@cloudflare/workers-types").Request): Promise<Response>;
    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void>;
    webSocketError(socket: WebSocket): void;
}
export { serializeRealtimeMessage };
