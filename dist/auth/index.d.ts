// Declarations for dillo/src/auth (built to dist/auth/index.js by
// build.mjs). Maintained beside the source until a tsc is vendored
// in the repo toolchain; src/auth/index.ts is the authority.
export declare const HANDOFF_CODE_TTL_MS: number;
export declare const HANDOFF_EXCHANGE_PATH: string;
export declare const ACCOUNTS_ORIGIN: string;
export declare const SESSION_ABSOLUTE_MS: number;
export declare const SESSION_IDLE_MS: number;
export declare const SESSION_TOUCH_MS: number;

export interface HandoffMember {
  id: string;
  email: string;
}
export interface HandoffTenant {
  id: string | null;
}
export type VerifyHandoffResult =
  | { ok: true; member: HandoffMember; tenant: HandoffTenant }
  | { ok: false; status: number; error: string };

export interface D1PreparedLike {
  bind(...args: unknown[]): {
    first(): Promise<Record<string, unknown> | null>;
    run(): Promise<unknown>;
  };
}
export interface D1Like {
  prepare(sql: string): D1PreparedLike;
}
export interface HandoffEnv {
  HANDOFF_SECRET?: unknown;
  SVC_ACCOUNTS?: { fetch: (input: string, init?: unknown) => Promise<Response> } | null;
  DB?: D1Like | null;
}

export declare function sha256Hex(text: string): Promise<string>;
export declare function timingSafeEqual(a: string, b: string): boolean;
export declare function resolveHandoffSecret(env: HandoffEnv): Promise<string>;
export declare const handoffSecret: typeof resolveHandoffSecret;
export declare function verifyHandoffSecret(presented: string, expected: string): boolean;

export interface HandoffCodeRecord {
  code_hash: string;
  member_id: string;
  email?: string;
  expires_at: number;
  used_at?: number | null;
}
export type HandoffCodeVerdict = "ok" | "unknown" | "used" | "expired" | "hash_mismatch";
export declare function checkHandoffCode(
  code: string,
  record: HandoffCodeRecord | null | undefined,
  opts?: { now?: number },
): Promise<HandoffCodeVerdict>;

export interface VerifyHandoffOptions {
  issuerKey?: string;
  handoffSecret?: string;
  secret?: string;
  env?: HandoffEnv;
  fetch?: (input: string, init?: unknown) => Promise<Response>;
  accountsOrigin?: string;
  now?: number;
  record?: HandoffCodeRecord | null;
  presentedSecret?: string;
}
export declare function verifyHandoff(
  code: string,
  opts?: VerifyHandoffOptions,
): Promise<VerifyHandoffResult>;
export declare function exchangeHandoffCode(
  code: string,
  env: HandoffEnv,
  opts?: Omit<VerifyHandoffOptions, "env">,
): Promise<VerifyHandoffResult>;

export declare function presentedSessionToken(request: Request, cookieName: string): string;
export interface RequireMemberOptions {
  cookieName?: string;
  table?: string;
  now?: number;
  absoluteMs?: number;
  idleMs?: number;
}
export declare function requireMember(
  request: Request,
  env: HandoffEnv,
  opts?: RequireMemberOptions,
): Promise<{ memberId: string; email: string } | null>;
