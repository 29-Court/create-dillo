import { type InternalVoucherRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
export declare function voucherJson(row: InternalVoucherRow): JsonObject;
export declare const VOUCHER_COLUMNS = "id, owner_id, name, code_prefix, capacity, remaining, expires_at, created_at, updated_at";
export declare function vouchersRoute(request: Request, env: ArmadilloEnv, currentAppId: string, id?: string, action?: string): Promise<Response>;
