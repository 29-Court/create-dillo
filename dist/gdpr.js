const PURPOSE_RE = /^[a-z][a-z0-9_-]{1,47}$/;
function validateGdprConfig(config) {
  if (!config) return void 0;
  if (config.dpoEmail !== void 0) {
    const email = config.dpoEmail.trim();
    if (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)) {
      throw new TypeError("GDPR dpoEmail must be a valid email address.");
    }
  }
  if (config.privacyPolicyUrl !== void 0) {
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
  if (config.retentionDays !== void 0) {
    if (!Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) {
      throw new TypeError("GDPR retentionDays must be an integer from 1 to 3650.");
    }
  }
  if (config.purposes !== void 0) {
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
function isValidGdprPurpose(value, allowed) {
  if (!PURPOSE_RE.test(value)) return false;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(value);
}
export {
  isValidGdprPurpose,
  validateGdprConfig
};
