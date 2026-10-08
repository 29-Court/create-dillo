export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
