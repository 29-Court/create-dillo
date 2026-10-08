export type CacheStrategy = "cache-first" | "stale-while-revalidate" | "network-only";

export interface CacheConfig {
  strategy?: CacheStrategy;
  ttl?: number;
  storage?: CacheStorage;
}

export interface CacheEntry<T = unknown> {
  value: T;
  table: string;
  createdAt: number;
  expiresAt: number;
}

/** Pluggable synchronous storage for query-cache entries. */
export interface CacheStorage {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  keys(): Iterable<string>;
  clear?(): void;
}

export class MemoryCacheStorage implements CacheStorage {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  keys(): Iterable<string> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface CacheLookup<T> {
  value: T;
  stale: boolean;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

/** Deterministic keys retain the full query so unrelated queries cannot collide. */
export function queryCacheKey(table: string, query: unknown): string {
  return `query:${JSON.stringify(table)}:${stable(query)}`;
}

export class QueryCache {
  readonly strategy: CacheStrategy;
  readonly ttl: number;
  private readonly storage: CacheStorage;
  // A shared store must never share authority between client instances.
  private readonly prefix = `armadillo:${Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (word) => word.toString(16).padStart(8, "0"),
  ).join("")}:`;
  private generation = 0;

  /** @internal Used to prevent in-flight reads from undoing invalidation. */
  get revision(): number { return this.generation; }

  constructor(config: CacheConfig = {}) {
    this.strategy = config.strategy ?? "network-only";
    this.ttl = config.ttl ?? 30_000;
    if (!Number.isFinite(this.ttl) || this.ttl < 0) {
      throw new TypeError("Cache ttl must be a non-negative number of milliseconds.");
    }
    this.storage = config.storage ?? new MemoryCacheStorage();
  }

  get<T>(key: string, currentTime = Date.now()): CacheLookup<T> | undefined {
    const entry = this.storage.get(this.prefix + key);
    if (!entry) return undefined;
    return { value: entry.value as T, stale: currentTime >= entry.expiresAt };
  }

  set<T>(key: string, table: string, value: T, ttl = this.ttl): void {
    const createdAt = Date.now();
    this.storage.set(this.prefix + key, { value, table, createdAt, expiresAt: createdAt + ttl });
  }

  invalidate(table: string): void {
    this.generation += 1;
    for (const key of this.storage.keys()) {
      if (key.startsWith(this.prefix) && this.storage.get(key)?.table === table) this.storage.delete(key);
    }
  }

  invalidateAll(): void {
    this.generation += 1;
    for (const key of this.storage.keys()) {
      if (key.startsWith(this.prefix)) this.storage.delete(key);
    }
  }
}
