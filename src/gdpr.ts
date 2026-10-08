export interface ArmadilloGdprConfig {
  /** Contact email for the Data Protection Officer / responsible person. Displayed in export and privacy responses. */
  dpoEmail?: string;
  /** Public URL of the privacy policy. Returned by GET /v1/gdpr/info. */
  privacyPolicyUrl?: string;
  /** Default retention in days for user-owned objects when not covered by collector retention. Undefined = keep indefinitely. */
  retentionDays?: number;
  /** Lawful purposes that require explicit consent. Shown in consent UI and validated on POST /v1/gdpr/consent. */
  purposes?: readonly string[];
  /** Require explicit consent before first write to a team-scoped collection. Defaults to false. */
  requireExplicitConsent?: boolean;
  /** If true, the data browser hides erased user tombstones. Defaults to true. */
  hideErasedUsers?: boolean;
}

export interface GdprConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  granted: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
}

export interface ArmadilloGdprExportBundle {
  exportId: string;
  user: { id: string; email: string; name: string | null; createdAt: string; updatedAt: string };
  consents: GdprConsentRecord[];
  memberships: Array<{ groupId: string; groupName: string; groupSlug: string; role: string; trusted: boolean }>;
  sessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
  apiKeys: Array<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: string }>;
  objects: Array<{ collection: string; id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }>;
  files: Array<{ id: string; name: string; contentType: string; size: number; createdAt: string }>;
  collectorSubmissions: Array<{ id: string; collectorId: string; data: Record<string, unknown>; createdAt: string; expiresAt: string }>;
  tickets: Array<{ id: string; label: string; metadata: Record<string, unknown>; createdAt: string }>;
  generatedAt: string;
  dpoEmail?: string;
  privacyPolicyUrl?: string;
}

const PURPOSE_RE = /^[a-z][a-z0-9_-]{1,47}$/;

export function validateGdprConfig(config: ArmadilloGdprConfig | undefined): ArmadilloGdprConfig | undefined {
  if (!config) return undefined;
  if (config.dpoEmail !== undefined) {
    const email = config.dpoEmail.trim();
    if (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)) {
      throw new TypeError("GDPR dpoEmail must be a valid email address.");
    }
  }
  if (config.privacyPolicyUrl !== undefined) {
    const url = config.privacyPolicyUrl.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
      } catch {
        throw new TypeError("GDPR privacyPolicyUrl must be an absolute https:// URL.");
      }
    }
  }
  if (config.retentionDays !== undefined) {
    if (!Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) {
      throw new TypeError("GDPR retentionDays must be an integer from 1 to 3650.");
    }
  }
  if (config.purposes !== undefined) {
    if (!Array.isArray(config.purposes) || config.purposes.length > 32) {
      throw new TypeError("GDPR purposes must be an array of up to 32 purpose slugs.");
    }
    for (const purpose of config.purposes) {
      if (typeof purpose !== "string" || !PURPOSE_RE.test(purpose)) {
        throw new TypeError(`GDPR purpose \`${purpose}\` is invalid. Use lowercase letters, numbers, hyphen, 2-48 chars.`);
      }
    }
    if (new Set(config.purposes).size !== config.purposes.length) {
      throw new TypeError("GDPR purposes must be unique.");
    }
  }
  return Object.freeze({ ...config });
}

export function isValidGdprPurpose(value: string, allowed: readonly string[] | undefined): boolean {
  if (!PURPOSE_RE.test(value)) return false;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(value);
}
