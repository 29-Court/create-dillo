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
export declare class MemoryCacheStorage implements CacheStorage {
    private readonly entries;
    get(key: string): CacheEntry | undefined;
    set(key: string, entry: CacheEntry): void;
    delete(key: string): void;
    keys(): Iterable<string>;
    clear(): void;
}
export interface CacheLookup<T> {
    value: T;
    stale: boolean;
}
/** Deterministic keys retain the full query so unrelated queries cannot collide. */
export declare function queryCacheKey(table: string, query: unknown): string;
export declare class QueryCache {
    readonly strategy: CacheStrategy;
    readonly ttl: number;
    private readonly storage;
    private readonly prefix;
    private generation;
    /** @internal Used to prevent in-flight reads from undoing invalidation. */
    get revision(): number;
    constructor(config?: CacheConfig);
    get<T>(key: string, currentTime?: number): CacheLookup<T> | undefined;
    set<T>(key: string, table: string, value: T, ttl?: number): void;
    invalidate(table: string): void;
    invalidateAll(): void;
}
