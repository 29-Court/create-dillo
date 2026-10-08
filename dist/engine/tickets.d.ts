import { type InternalTicketRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloTicketPolicy } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
export declare const TICKET_COLUMNS = "id, owner_id, team_id, holder_id, label, event_id, code_prefix,\n  metadata, expires_at, consumed_at, consumed_by, created_at, updated_at";
export declare function ticketJson(row: InternalTicketRow): JsonObject;
export declare function ticketRoles(policy: ArmadilloTicketPolicy, action: "read" | "issue" | "consume"): readonly string[] | undefined;
export declare function ticketsRoute(request: Request, env: ArmadilloEnv, currentAppId: string, policy: ArmadilloTicketPolicy | undefined, id?: string): Promise<Response>;
