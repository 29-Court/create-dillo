import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { INTERNAL_TABLES } from "../internal-schema.js";
const LOCAL_BACKUP_FORMAT = "armadillo-local-backup/v1";
const FIDELITY = {
  ids: "stable",
  ownershipAndGroups: "preserved",
  files: "included-with-checksums",
  sessions: "not-exported",
  apiKeySecrets: "redacted-recreate-from-checklist",
  passwordHashes: "retained-for-login-continuity-not-plaintext",
  bootstrapSecret: "never-in-database-burn-record-only",
  importTarget: "empty-destination-only"
};
const REDACTED_KEY_HASH = "export-redacted";
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function assertEmptyDestination(path, label) {
  if (!await pathExists(path)) return;
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${label} already exists and is not a directory: ${path}`);
  }
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`${label} must be empty for import; found ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${path}`);
  }
}
async function assertDirectoryEmptyOrMissing(path, label) {
  if (!await pathExists(path)) return;
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${label} already exists and is not a directory: ${path}`);
  }
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`${label} must be empty; found existing contents at ${path}`);
  }
}
async function inventoryFiles(root) {
  if (!await pathExists(root)) return [];
  const out = [];
  async function walk(dir) {
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
        bytes: bytes.byteLength
      });
    }
  }
  await walk(root);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
function countOrZero(database, sql, appId) {
  try {
    const row = database.prepare(sql).get(appId);
    return Number(row?.n ?? 0);
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
}
function scrubSecrets(database, appId) {
  const checklist = [
    "All sessions: re-login required (sessions not exported).",
    "Bootstrap one-time secret: never stored in the database; burn record preserved."
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
    try {
      database.exec(`DELETE FROM ${INTERNAL_TABLES.rateLimits}`);
    } catch (error) {
      if (!(error instanceof Error && /no such table/i.test(error.message))) throw error;
    }
    const keys = database.prepare(
      `SELECT id, name, key_prefix, scopes, revoked_at FROM ${INTERNAL_TABLES.apiKeys} WHERE app_id = ? ORDER BY created_at, id`
    ).all(appId);
    for (const key of keys) {
      checklist.push(
        `API key ${key.name} (id=${key.id}, prefix=${key.key_prefix}, scopes=${key.scopes}${key.revoked_at ? ", was-revoked" : ""}): recreate; secret hash redacted.`
      );
    }
    database.prepare(
      `UPDATE ${INTERNAL_TABLES.apiKeys}
            SET key_hash = ?, revoked_at = COALESCE(revoked_at, ?)
          WHERE app_id = ?`
    ).run(REDACTED_KEY_HASH, (/* @__PURE__ */ new Date()).toISOString(), appId);
    try {
      const invites = database.prepare(`SELECT id, name FROM ${INTERNAL_TABLES.bridgeInvites} WHERE app_id = ?`).all(appId);
      for (const invite of invites) {
        checklist.push(`Bridge invite ${invite.name || invite.id}: claim token hash redacted; issue a fresh invite.`);
      }
      database.prepare(`UPDATE ${INTERNAL_TABLES.bridgeInvites} SET token_hash = ? WHERE app_id = ?`).run(REDACTED_KEY_HASH, appId);
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
function verifyFileBodies(database, appId, filesDirectory) {
  const rows = database.prepare(
    `SELECT id, storage_key, name FROM ${INTERNAL_TABLES.files} WHERE app_id = ? ORDER BY id`
  ).all(appId);
  for (const row of rows) {
    if (!row.storage_key || typeof row.storage_key !== "string") {
      throw new Error(`File ${row.id} (${row.name}) is missing a storage_key; refusing torn export.`);
    }
  }
  void filesDirectory;
}
async function exportLocalBackup(options) {
  const appId = options.appId.trim();
  if (!appId) throw new TypeError("appId is required.");
  const databasePath = resolve(options.databasePath);
  const filesDirectory = resolve(options.filesDirectory);
  const outDirectory = resolve(options.outDirectory);
  if (!await pathExists(databasePath)) {
    throw new Error(`Database not found: ${databasePath}`);
  }
  await assertDirectoryEmptyOrMissing(outDirectory, "Backup outDirectory");
  await mkdir(outDirectory, { recursive: true });
  const snapshotPath = join(outDirectory, "state.sqlite");
  const filesOut = join(outDirectory, "files");
  let source;
  let scrubbed;
  try {
    source = new DatabaseSync(databasePath);
    await backup(source, snapshotPath);
    source.close();
    source = void 0;
    scrubbed = new DatabaseSync(snapshotPath);
    scrubbed.exec("PRAGMA foreign_keys = ON");
    const appRow = scrubbed.prepare(`SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.users} WHERE app_id = ?`).get(appId);
    if (!appRow || Number(appRow.n) < 1) {
      const any = scrubbed.prepare(`SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.bootstrap} WHERE app_id = ?`).get(appId);
      if (!any || Number(any.n) < 1) {
        const objectCount = countOrZero(
          scrubbed,
          `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.objects} WHERE app_id = ?`,
          appId
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
      apiKeysRedacted
    };
    scrubbed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    scrubbed.close();
    scrubbed = void 0;
    if (await pathExists(filesDirectory)) {
      await cp(filesDirectory, filesOut, { recursive: true });
    } else {
      await mkdir(filesOut, { recursive: true });
    }
    const segments = [];
    const dbBytes = await readFile(snapshotPath);
    segments.push({ path: "state.sqlite", sha256: sha256(dbBytes), bytes: dbBytes.byteLength });
    for (const file of await inventoryFiles(filesOut)) {
      segments.push({
        path: `files/${file.relativePath}`,
        sha256: file.sha256,
        bytes: file.bytes
      });
    }
    const manifest = {
      format: LOCAL_BACKUP_FORMAT,
      appId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      fidelity: { ...FIDELITY },
      secretsChecklist: checklist,
      counts,
      segments
    };
    await writeFile(join(outDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(
      join(outDirectory, "secrets-checklist.json"),
      `${JSON.stringify({ appId, items: checklist }, null, 2)}
`,
      "utf8"
    );
    return manifest;
  } catch (error) {
    source?.close();
    scrubbed?.close();
    await rm(outDirectory, { recursive: true, force: true });
    throw error;
  }
}
async function importLocalBackup(options) {
  const appId = options.appId.trim();
  if (!appId) throw new TypeError("appId is required.");
  const archiveDirectory = resolve(options.archiveDirectory);
  const databasePath = resolve(options.databasePath);
  const filesDirectory = resolve(options.filesDirectory);
  const manifestPath = join(archiveDirectory, "manifest.json");
  if (!await pathExists(manifestPath)) {
    throw new Error(`Backup manifest missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== LOCAL_BACKUP_FORMAT) {
    throw new Error(
      `Unsupported backup format \`${String(manifest.format)}\`; expected ${LOCAL_BACKUP_FORMAT}.`
    );
  }
  if (manifest.appId !== appId) {
    throw new Error(`Backup appId \`${manifest.appId}\` does not match requested \`${appId}\`.`);
  }
  if (await pathExists(databasePath)) {
    throw new Error(`Import destination database already exists: ${databasePath}`);
  }
  await assertEmptyDestination(filesDirectory, "Import filesDirectory");
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
        `Backup segment checksum mismatch for ${segment.path}: expected ${segment.sha256}/${segment.bytes}, got ${digest}/${bytes.byteLength}.`
      );
    }
  }
  await mkdir(dirname(databasePath), { recursive: true });
  await cp(join(archiveDirectory, "state.sqlite"), databasePath);
  await mkdir(filesDirectory, { recursive: true });
  if (await pathExists(join(archiveDirectory, "files"))) {
    await cp(join(archiveDirectory, "files"), filesDirectory, { recursive: true });
  }
  const restored = new DatabaseSync(databasePath);
  try {
    restored.exec("PRAGMA foreign_keys = ON");
    const sessions = countOrZero(restored, `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?`, appId);
    if (sessions !== 0) {
      throw new Error("Restored database unexpectedly contains sessions; backup scrub failed.");
    }
    const liveKeys = restored.prepare(
      `SELECT COUNT(*) AS n FROM ${INTERNAL_TABLES.apiKeys} WHERE app_id = ? AND key_hash != ?`
    ).get(appId, REDACTED_KEY_HASH);
    if (Number(liveKeys?.n ?? 0) !== 0) {
      throw new Error("Restored database still has unreacted API key hashes; backup scrub failed.");
    }
  } finally {
    restored.close();
  }
  return manifest;
}
export {
  LOCAL_BACKUP_FORMAT,
  exportLocalBackup,
  importLocalBackup
};
