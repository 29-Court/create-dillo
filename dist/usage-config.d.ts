/** Optional daily UTC quota ceilings. Positive safe integers only. */
export type UsageQuotas = {
    /** Max API requests counted per UTC day. Burrow and health are exempt. */
    readonly requestsPerDay?: number;
    readonly recordsWrittenPerDay?: number;
    readonly functionCallsPerDay?: number;
    readonly filesStoredBytesPerDay?: number;
    readonly filesServedBytesPerDay?: number;
    readonly webhookDeliveriesPerDay?: number;
    readonly realtimeConnectionsPerDay?: number;
};
/** Backend `usage` declaration. Quotas are optional; metering still records. */
export type UsageConfig = {
    readonly quotas?: UsageQuotas;
};
export declare function validateUsageConfig(usage: UsageConfig | undefined): void;
