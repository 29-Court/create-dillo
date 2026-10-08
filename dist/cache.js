class MemoryCacheStorage {
  entries = /* @__PURE__ */ new Map();
  get(key) {
    return this.entries.get(key);
  }
  set(key, entry) {
    this.entries.set(key, entry);
  }
  delete(key) {
    this.entries.delete(key);
  }
  keys() {
    return this.entries.keys();
  }
  clear() {
    this.entries.clear();
  }
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
function queryCacheKey(table, query) {
  return `query:${JSON.stringify(table)}:${stable(query)}`;
}
class QueryCache {
  strategy;
  ttl;
  storage;
  // A shared store must never share authority between client instances.
  prefix = `armadillo:${Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (word) => word.toString(16).padStart(8, "0")
  ).join("")}:`;
  generation = 0;
  /** @internal Used to prevent in-flight reads from undoing invalidation. */
  get revision() {
    return this.generation;
  }
  constructor(config = {}) {
    this.strategy = config.strategy ?? "network-only";
    this.ttl = config.ttl ?? 3e4;
    if (!Number.isFinite(this.ttl) || this.ttl < 0) {
      throw new TypeError("Cache ttl must be a non-negative number of milliseconds.");
    }
    this.storage = config.storage ?? new MemoryCacheStorage();
  }
  get(key, currentTime = Date.now()) {
    const entry = this.storage.get(this.prefix + key);
    if (!entry) return void 0;
    return { value: entry.value, stale: currentTime >= entry.expiresAt };
  }
  set(key, table, value, ttl = this.ttl) {
    const createdAt = Date.now();
    this.storage.set(this.prefix + key, { value, table, createdAt, expiresAt: createdAt + ttl });
  }
  invalidate(table) {
    this.generation += 1;
    for (const key of this.storage.keys()) {
      if (key.startsWith(this.prefix) && this.storage.get(key)?.table === table) this.storage.delete(key);
    }
  }
  invalidateAll() {
    this.generation += 1;
    for (const key of this.storage.keys()) {
      if (key.startsWith(this.prefix)) this.storage.delete(key);
    }
  }
}
export {
  MemoryCacheStorage,
  QueryCache,
  queryCacheKey
};
