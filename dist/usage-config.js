function validateUsageConfig(usage) {
  if (usage === void 0) return;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw new TypeError("usage must be an object when provided.");
  }
  const quotas = usage.quotas;
  if (quotas === void 0) return;
  if (quotas === null || typeof quotas !== "object" || Array.isArray(quotas)) {
    throw new TypeError("usage.quotas must be an object when provided.");
  }
  for (const [key, value] of Object.entries(quotas)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`usage.quotas.${key} must be a positive safe integer.`);
    }
  }
}
export {
  validateUsageConfig
};
