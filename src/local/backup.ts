/**
 * Local versioned backup / restore (Slice 1).
 *
 * Format: armadillo-local-backup/v1 — a directory with manifest.json,
 * state.sqlite (quiesced SQLite snapshot with live credentials scrubbed),
 * and a files/ tree. Cloudflare D1/R2 and scheduled backups are later work.
 */
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { INTERNAL_TABLES } from "../internal-schema.js";

export const LOCAL_BACKUP_FORMAT = "armadillo-local-backup/v1" as const;

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

const FIDELITY: LocalBackupFidelity = {
  ids: "stable",
  ownershipAndGroups: "preserved",
  files: "included-with-checksums",
  sessions: "not-exported",
  apiKeySecrets: "redacted-recreate-from-checklist",
  passwordHashes: "retained-for-login-continuity-not-plaintext",
  bootstrapSecret: "never-in-database-burn-record-only",
  importTarget: "empty-destination-only",
};

const REDACTED_KEY_HASH = "export-redacted";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertEmptyDestination(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${label} already exists and is not a directory: ${path}`);
  }
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`${label} must be empty for import; found ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${path}`);
  }
}

async function assertDirectoryEmptyOrMissing(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${label} already exists and is not a directory: ${path}`);
  }
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`${label} must be empty; found existing contents at ${path}`);
  }
}

async function inventoryFiles(root: string): Promise<Array<{ relativePath: string; absolute: string; sha256: string; bytes: number }>> {
  if (!(await pathExists(root))) return [];
  const out: Array<{ relativePath: string; absolute: string; sha256: string; bytes: number }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(absolute);
      out.push({
        relativePath: relative(root, absolute).split(sep).join("/"),
        absolute,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      });
    }
  }
  await walk(root);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function countOrZero(database: DatabaseSync, sql: string, appId: string): number {
  try {
    const row = database.prepare(sql).get(appId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } catch (error) {
    // Table may be absent on truncated fixtures; treat as zero rather than silent corruption.
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
}

function scrubSecrets(database: DatabaseSync, appId: string): { checklist: string[]; apiKeysRedacted: number } {
  const checklist: string[] = [
    "All sessions: re-login required (sessions not exported).",
    "Bootstrap one-time secret: never stored in the database; burn record preserved.",
  ];

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.magicLinks} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.bootstrapSessions} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.oauthStates} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.ticketTokens} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.fileUploads} WHERE app_id = ?`).run(appId);
    database.prepare(`DELETE FROM ${INTERNAL_TABLES.realtimeConnections} WHERE app_id = ?`).run(appId);
    // Rate limits are keyed by hash only (no app_id); wipe to avoid carrying abuse counters.
    try {
      database.exec(`DELETE FROM ${INTERNAL_TABLES.rateLimits}`);
    } catch (error) {
      if (!(error instanceof Error && /no such table/i.test(error.message))) throw error;
    }

    const keys = database
      .prepare(
        `SELECT id, name, key_prefix, scopes, revoked_at FROM ${INTERNAL_TABLES.apiKeys} WHERE app_id = ? ORDER BY created_at, id`,
      )
      .all(appId) as Array<{ id: string; name: string; key_prefix: string; scopes: string; revoked_at: string | null }>;

    for (const key of keys) {
      checklist.push(
        `API key ${key.name} (id=${key.id}, prefix=${key.key_prefix}, scopes=${key.scopes}${key.revoked_at ? ", was-revoked" : ""}): recreate; secret hash redacted.`,
      );
    }
    database
      .prepare(
        `UPDATE ${INTERNAL_TABLES.apiKeys}
            SET key_hash = ?, revoked_at = COALESCE(revoked_at, ?)
          WHERE app_id = ?`,
      )
      .run(REDACTED_KEY_HASH, new Date().toISOString(), appId);

    // Bridge invite claim tokens must not survive export.
    try {
      const invites = database
        .prepare(`SELECT id, name FROM ${INTERNAL_TABLES.bridgeInvites} WHERE app_id = ?`)
        .all(appId) as Array<{ id: string; name: string }>;
      for (const invite of invites) {
        checklist.push(`Bridge invite ${invite.name || invite.id}: claim token hash redacted; issue a fresh invite.`);
      }
      database
        .prepare(`UPDATE ${INTERNAL_TABLES.bridgeInvites} SET token_hash = ? WHERE app_id = ?`)
        .run(REDACTED_KEY_HASH, appId);
    } catch (error) {
      if (!(error instanceof Error && /no such table/i.test(error.message))) throw error;
    }

    database.exec("COMMIT");
    return { checklist, apiKeysRedacted: keys.length };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function verifyFileBodies(database: DatabaseSync, appId: string, filesDirectory: string): void {
  const rows = database
    .prepare(
      `SELECT id, storage_key, name FROM ${INTERNAL_TABLES.files} WHERE app_id = ? ORDER BY id`,
    )
    .all(appId) as Array<{ id: string; storage_key: string; name: string }>;
  // Local storage addresses bodies by sha256(storage_key) under objects/; we do not reimplement
  // that layout here — instead require the complete files directory to be copied and rely on
  // post-copy checksum inventory. Missing storage_key values still fail loudly.
  for (const row of rows) {
    if (!row.storage_key || typeof row.storage_key !== "string") {
      throw new Error(`File ${row.id} (${row.name}) is missing a storage_key; refusing torn export.`);
    }
  }
  void filesDirectory;
}

/**
 * Export a quiesced local application into a versioned backup directory.
 * The source database must not be open by a live server (close LocalArmadilloServer first).
 */
export async function exportLocalBackup(options: ExportLocalBackupOptions): Promise<LocalBackupManifest> {
  const appId = options.appId.trim();
  if (!appId) throw new TypeError("appId is required.");
  const databasePath = resolve(options.databasePath);
  const filesDirectory = resolve(options.filesDirectory);
  const outDirectory = resolve(options.outDirectory);

  if (!(await pathExists(databasePath))) {
    throw new Error(`Database not found: ${databasePath}`);
  }
  await assertDirectoryEmptyOrMissing(outDirectory, "Backup outDirectory");

  await mkdir(outDirectory, { recursive: true });
  const snapshotPath = join(outDirectory, "state.sqlite");
  const filesOut = join(outDirectory, "files");

  let source: DatabaseSync | undefined;
  let scrubbed: DatabaseSync | undefined;
  try {
    // Online-safe SQLite backup into the archive. Operators should still quiesce
    // writers so file bodies and DB rows land in the same logical moment.
    source = new DatabaseSync(databasePath);
    await backup(source, snapshotPath);
    source.close();
    source = undefined;

    scrubbed = new DatabaseSync(snapshotPath);
    scrubbed.exec("PRAGMA foreign_keys = ON");

    const appRow = scrubbed
      .prepare(`SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.users} WHERE app_id = ?`)
      .get(appId) as { n: number } | undefined;
    if (!appRow || Number(appRow.n) < 1) {
      // Allow empty apps that still have bootstrap/schema; require at least one internal row for appId.
      const any = scrubbed
        .prepare(`SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.bootstrap} WHERE app_id = ?`)
        .get(appId) as { n: number } | undefined;
      if (!any || Number(any.n) < 1) {
        const objectCount = countOrZero(
          scrubbed,
          `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.objects} WHERE app_id = ?`,
          appId,
        );
        if (objectCount < 1) {
          throw new Error(`No data found for appId \`${appId}\` in ${databasePath}.`);
        }
      }
    }

    verifyFileBodies(scrubbed, appId, filesDirectory);
    const { checklist, apiKeysRedacted } = scrubSecrets(scrubbed, appId);

    const counts = {
      users: countOrZero(scrubbed, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.users} WHERE app_id = ?`, appId),
      groups: countOrZero(scrubbed, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.groups} WHERE app_id = ?`, appId),
      members: countOrZero(scrubbed, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.groupMembers} WHERE app_id = ?`, appId),
      objects: countOrZero(scrubbed, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.objects} WHERE app_id = ?`, appId),
      files: countOrZero(scrubbed, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.files} WHERE app_id = ?`, appId),
      apiKeysRedacted,
    };

    scrubbed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    scrubbed.close();
    scrubbed = undefined;

    if (await pathExists(filesDirectory)) {
      await cp(filesDirectory, filesOut, { recursive: true });
    } else {
      await mkdir(filesOut, { recursive: true });
    }

    const segments: LocalBackupSegment[] = [];
    const dbBytes = await readFile(snapshotPath);
    segments.push({ path: "state.sqlite", sha256: sha256(dbBytes), bytes: dbBytes.byteLength });

    for (const file of await inventoryFiles(filesOut)) {
      segments.push({
        path: `files/${file.relativePath}`,
        sha256: file.sha256,
        bytes: file.bytes,
      });
    }

    const manifest: LocalBackupManifest = {
      format: LOCAL_BACKUP_FORMAT,
      appId,
      createdAt: new Date().toISOString(),
      fidelity: { ...FIDELITY },
      secretsChecklist: checklist,
      counts,
      segments,
    };
    await writeFile(join(outDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(outDirectory, "secrets-checklist.json"),
      `${JSON.stringify({ appId, items: checklist }, null, 2)}\n`,
      "utf8",
    );
    return manifest;
  } catch (error) {
    source?.close();
    scrubbed?.close();
    await rm(outDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Restore a versioned local backup into an empty destination.
 * Refuses non-empty targets and format/appId mismatches.
 */
export async function importLocalBackup(options: ImportLocalBackupOptions): Promise<LocalBackupManifest> {
  const appId = options.appId.trim();
  if (!appId) throw new TypeError("appId is required.");
  const archiveDirectory = resolve(options.archiveDirectory);
  const databasePath = resolve(options.databasePath);
  const filesDirectory = resolve(options.filesDirectory);

  const manifestPath = join(archiveDirectory, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Backup manifest missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LocalBackupManifest;
  if (manifest.format !== LOCAL_BACKUP_FORMAT) {
    throw new Error(
      `Unsupported backup format \`${String((manifest as { format?: string }).format)}\`; expected ${LOCAL_BACKUP_FORMAT}.`,
    );
  }
  if (manifest.appId !== appId) {
    throw new Error(`Backup appId \`${manifest.appId}\` does not match requested \`${appId}\`.`);
  }

  if (await pathExists(databasePath)) {
    throw new Error(`Import destination database already exists: ${databasePath}`);
  }
  await assertEmptyDestination(filesDirectory, "Import filesDirectory");

  // Verify every segment checksum before writing anything.
  for (const segment of manifest.segments) {
    if (segment.path.includes("..") || segment.path.startsWith("/") || segment.path.includes("\0")) {
      throw new Error(`Refusing unsafe backup segment path: ${segment.path}`);
    }
    const absolute = join(archiveDirectory, segment.path);
    if (!absolute.startsWith(archiveDirectory + sep) && absolute !== archiveDirectory) {
      throw new Error(`Refusing backup segment outside archive: ${segment.path}`);
    }
    const bytes = await readFile(absolute);
    const digest = sha256(bytes);
    if (digest !== segment.sha256 || bytes.byteLength !== segment.bytes) {
      throw new Error(
        `Backup segment checksum mismatch for ${segment.path}: expected ${segment.sha256}/${segment.bytes}, got ${digest}/${bytes.byteLength}.`,
      );
    }
  }

  await mkdir(dirname(databasePath), { recursive: true });
  await cp(join(archiveDirectory, "state.sqlite"), databasePath);
  await mkdir(filesDirectory, { recursive: true });
  if (await pathExists(join(archiveDirectory, "files"))) {
    await cp(join(archiveDirectory, "files"), filesDirectory, { recursive: true });
  }

  // Confirm restored DB opens and still has no live sessions / redacted keys.
  const restored = new DatabaseSync(databasePath);
  try {
    restored.exec("PRAGMA foreign_keys = ON");
    const sessions = countOrZero(restored, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?`, appId);
    if (sessions !== 0) {
      throw new Error("Restored database unexpectedly contains sessions; backup scrub failed.");
    }
    const liveKeys = restored
      .prepare(
        `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.apiKeys} WHERE app_id = ? AND key_hash != ?`,
      )
      .get(appId, REDACTED_KEY_HASH) as { n: number } | undefined;
    if (Number(liveKeys?.n ?? 0) !== 0) {
      throw new Error("Restored database still has unreacted API key hashes; backup scrub failed.");
    }
  } finally {
    restored.close();
  }

  return manifest;
}
