import type { EngineDatabase, ObjectStorage, RealtimeNamespace } from "./ports.js";
import { type SendMailJob, type MailDelivery } from "./mail.js";
import { type ArmadilloAuthProvider } from "../backend.js";
import { type ArmadilloBackendErrorCode } from "../backend.js";
import { type InternalUserRow } from "../backend.js";
import { type JsonValue } from "../backend.js";

export interface ArmadilloSecretVault {
  put(name: string, value: string): Promise<void>;
}

export interface EngineEnvironment {
  /** Owned resources supplied by runtime adapters; legacy environments remain supported. */
  resources?: import("./runtime.js").ArmadilloResources;
  DB: EngineDatabase;
  FILES: ObjectStorage;
  MAIL_QUEUE?: { send(job: SendMailJob): Promise<void> };
  ARMADILLO_MAIL_DELIVERY?: MailDelivery;
  /** Durable Object namespace used by the optional realtime layer. */
  ARMADILLO_REALTIME?: RealtimeNamespace;
  ARMADILLO_APP_ID?: string;
  /** Alchemy stage, or `local` for the self-hosted local adapter. */
  ARMADILLO_STAGE?: string;
  ARMADILLO_SIGNUP_MODE?: "open" | "closed";
  ARMADILLO_ADMIN_KEY?: string;
  ARMADILLO_BOOTSTRAP_SECRET?: string;
  /**
   * Opt in to multi-tenant `x-armadillo-app-id` header routing. Off by default so
   * an anonymous caller cannot select the tenant namespace that scopes every
   * auth query, session cookie, and rate-limit bucket.
   */
  ARMADILLO_ALLOW_CLIENT_APP_ID?: string;
  /**
   * Set to `1` only when a proxy in front of this deployment rewrites the
   * forwarded client-IP header. Leaving it unset makes Armadillo ignore
   * caller-supplied `x-forwarded-for` for rate limiting.
   */
  ARMADILLO_TRUST_FORWARDED_IP?: string;
  /** Header to read the client IP from when forwarded IPs are trusted. */
  ARMADILLO_FORWARDED_IP_HEADER?: string;
  /** Local development secret file. Production uses the platform secret store instead. */
  ARMADILLO_SECRET_VAULT?: ArmadilloSecretVault;
  ARMADILLO_SUPERADMIN_GROUP?: string;
  ARMADILLO_PUBLIC_URL?: string;
  ARMADILLO_MAIL_FROM?: string;
  /** Optional branding for the shared transactional-email template. */
  ARMADILLO_MAIL_BRAND_NAME?: string;
  ARMADILLO_MAIL_ACCENT_COLOR?: string;
  ARMADILLO_MAIL_WEBHOOK?: string;
  ARMADILLO_MAIL_WEBHOOK_TOKEN?: string;
  ARMADILLO_DEV_MODE?: string;
  /**
   * Second, independent opt-in required before any secret is written into an
   * HTTP response. `ARMADILLO_DEV_MODE=1` alone no longer echoes a live magic
   * link: one misconfigured boolean was enough to leak a working sign-in token.
   */
  ARMADILLO_EXPOSE_DEBUG_TOKENS?: string;
  RESEND_API_KEY?: string;
  /** Cloudflare Email Sending API credentials, normally Worker secrets. */
  CF_EMAIL_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ARMADILLO_PASSWORD_ITERATIONS?: string;
  ARMADILLO_SESSION_TTL_SECONDS?: string;
  /**
   * Cap on API-key issuance (and rotation, which shares the bucket) per user
   * per hour. Defaults to 30; raise for bulk provisioning workflows.
   */
  ARMADILLO_API_KEY_ISSUE_LIMIT?: string;
  ARMADILLO_MAGIC_LINK_TTL_SECONDS?: string;
  ARMADILLO_MAX_JSON_BYTES?: string;
  ARMADILLO_MAX_FILE_BYTES?: string;
  CORS_ORIGIN?: string;
  /** @internal Used by SQL-compatible adapters that reuse the Armadillo runtime. */
  ARMADILLO_SQL_DIALECT?: "sqlite" | "postgres";
  /** @internal Provider-native signed object URLs, supplied by the storage adapter. */
  ARMADILLO_FILE_URLS?: ArmadilloFileUrlAdapter;
  /** Provider stream framing, preserving bounded consumption and known length. */
  ARMADILLO_UPLOAD_BODY?: (request: Request, maximum: number) => ReadableStream<Uint8Array>;
  /** @internal Human-readable storage names returned by the service root. */
  ARMADILLO_STORAGE_LABELS?: readonly string[];
  /** @internal Adapter description returned by the service root. */
  ARMADILLO_PURPOSE?: string;
}

export interface ArmadilloDownloadUrlOptions {
  /**
   * Response headers the store must apply. Armadillo pins these for content
   * types a browser would render as active content, because a presigned URL
   * bypasses the download route's own `attachment` + `nosniff` headers.
   */
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface ArmadilloFileUrlAdapter {
  upload(key: string, contentType: string, expiresIn: number): Promise<string>;
  download(key: string, expiresIn: number, options?: ArmadilloDownloadUrlOptions): Promise<string>;
}

export type ArmadilloEnv = EngineEnvironment;

export const AUTH_PROVIDER = Symbol("armadillo-auth-provider");

export type RuntimeAuthEnv = ArmadilloEnv & { [AUTH_PROVIDER]?: ArmadilloAuthProvider };

export type ErrorCode = ArmadilloBackendErrorCode;

export type BindValue = string | number | null;

export interface AuthContext {
  user: InternalUserRow;
  tokenHash: string;
  external?: boolean;
  /**
   * How this session was proven: `password`, `magic_link`, or `oauth`. Used to
   * require step-up proof before destructive credential changes.
   */
  authMethod?: SessionAuthMethod;
  principal: {
    type: "user" | "api_key";
    id: string;
    name: string | null;
    scopes: readonly string[];
  };
}

export type SessionAuthMethod = "password" | "magic_link" | "oauth";

export interface QueryFilter {
  field: string;
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "contains";
  value: JsonValue;
}

export interface QueryOrder {
  field: string;
  direction: "asc" | "desc";
}

export interface QueryExpand {
  field: string;
  expand?: string[];
}

export interface NearConstraint {
  field: string;
  center: { latitude: number; longitude: number; altitude?: number };
  radius: number;
  unit: "meters" | "kilometers" | "miles";
}

export interface BoundingBoxConstraint {
  field: string;
  northEast: { latitude: number; longitude: number; altitude?: number };
  southWest: { latitude: number; longitude: number; altitude?: number };
}

export interface SpatialOrder {
  field: string;
  center: { latitude: number; longitude: number; altitude?: number };
  direction: "nearest" | "farthest";
}

export { PACKAGE_VERSION as ARMADILLO_VERSION } from "../versions.js";
