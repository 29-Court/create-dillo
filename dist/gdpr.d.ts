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
    user: {
        id: string;
        email: string;
        name: string | null;
        createdAt: string;
        updatedAt: string;
    };
    consents: GdprConsentRecord[];
    memberships: Array<{
        groupId: string;
        groupName: string;
        groupSlug: string;
        role: string;
        trusted: boolean;
    }>;
    sessions: Array<{
        id: string;
        createdAt: string;
        expiresAt: string;
    }>;
    apiKeys: Array<{
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        createdAt: string;
    }>;
    objects: Array<{
        collection: string;
        id: string;
        data: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
    }>;
    files: Array<{
        id: string;
        name: string;
        contentType: string;
        size: number;
        createdAt: string;
    }>;
    collectorSubmissions: Array<{
        id: string;
        collectorId: string;
        data: Record<string, unknown>;
        createdAt: string;
        expiresAt: string;
    }>;
    tickets: Array<{
        id: string;
        label: string;
        metadata: Record<string, unknown>;
        createdAt: string;
    }>;
    generatedAt: string;
    dpoEmail?: string;
    privacyPolicyUrl?: string;
}
export declare function validateGdprConfig(config: ArmadilloGdprConfig | undefined): ArmadilloGdprConfig | undefined;
export declare function isValidGdprPurpose(value: string, allowed: readonly string[] | undefined): boolean;
