export declare const LOCAL_BACKUP_FORMAT: "armadillo-local-backup/v1";
export interface LocalBackupSegment {
    path: string;
    sha256: string;
    bytes: number;
}
export interface LocalBackupFidelity {
    ids: "stable";
    ownershipAndGroups: "preserved";
    files: "included-with-checksums";
    sessions: "not-exported";
    apiKeySecrets: "redacted-recreate-from-checklist";
    passwordHashes: "retained-for-login-continuity-not-plaintext";
    bootstrapSecret: "never-in-database-burn-record-only";
    importTarget: "empty-destination-only";
}
export interface LocalBackupManifest {
    format: typeof LOCAL_BACKUP_FORMAT;
    appId: string;
    createdAt: string;
    fidelity: LocalBackupFidelity;
    secretsChecklist: string[];
    counts: {
        users: number;
        groups: number;
        members: number;
        objects: number;
        files: number;
        apiKeysRedacted: number;
    };
    segments: LocalBackupSegment[];
}
export interface ExportLocalBackupOptions {
    appId: string;
    databasePath: string;
    filesDirectory: string;
    outDirectory: string;
}
export interface ImportLocalBackupOptions {
    appId: string;
    archiveDirectory: string;
    databasePath: string;
    filesDirectory: string;
}
/**
 * Export a quiesced local application into a versioned backup directory.
 * The source database must not be open by a live server (close LocalArmadilloServer first).
 */
export declare function exportLocalBackup(options: ExportLocalBackupOptions): Promise<LocalBackupManifest>;
/**
 * Restore a versioned local backup into an empty destination.
 * Refuses non-empty targets and format/appId mismatches.
 */
export declare function importLocalBackup(options: ImportLocalBackupOptions): Promise<LocalBackupManifest>;
