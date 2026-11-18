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

export function validateUsageConfig(usage: UsageConfig | undefined): void {
  if (usage === undefined) return;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw new TypeError("usage must be an object when provided.");
  }
  const quotas = usage.quotas;
  if (quotas === undefined) return;
  if (quotas === null || typeof quotas !== "object" || Array.isArray(quotas)) {
    throw new TypeError("usage.quotas must be an object when provided.");
  }
  for (const [key, value] of Object.entries(quotas)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`usage.quotas.${key} must be a positive safe integer.`);
    }
  }
}
