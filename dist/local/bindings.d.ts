/** Rewrite SQLite numbered placeholders while preserving literals and comments. */
export declare function normalizeBindings(query: string, input: readonly unknown[]): {
    sql: string;
    values: unknown[];
};
