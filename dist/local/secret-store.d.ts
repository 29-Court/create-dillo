/** Local stand-in for platform secrets. Values stay in a 0600 file, not in the database. */
export declare function attachSecretVault(databasePath: string, env: Record<string, unknown>): void;
