import { Command, Args, Flags } from '@oclif/core';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { doctor } from '../project.js';

type LocalBackupApi = {
  exportLocalBackup: (options: {
    appId: string;
    databasePath: string;
    filesDirectory: string;
    outDirectory: string;
  }) => Promise<unknown>;
  importLocalBackup: (options: {
    appId: string;
    archiveDirectory: string;
    databasePath: string;
    filesDirectory: string;
  }) => Promise<unknown>;
};

export default class Backup extends Command {
  static description = 'Export or restore a local Dillo SQLite/files backup';
  static enableJsonFlag = true;
  static args = {
    operation: Args.string({ required: true, options: ['export', 'restore'] }),
  };
  static flags = {
    directory: Flags.string({ default: '.', description: 'Application directory (for library resolution)' }),
    'app-id': Flags.string({ required: true, description: 'Application id' }),
    database: Flags.string({ required: true, description: 'Path to state.sqlite' }),
    files: Flags.string({ required: true, description: 'Path to local files directory' }),
    archive: Flags.string({ required: true, description: 'Backup archive directory' }),
  };

  async run() {
    const { args, flags } = await this.parse(Backup);
    await doctor(flags.directory);
    const require = createRequire(resolve(flags.directory, 'package.json'));
    let local: LocalBackupApi;
    try {
      local = require('create-dillo/local') as LocalBackupApi;
    } catch {
      throw new Error('Dillo local adapter is not installed. Run npm install in the application.');
    }
    if (typeof local.exportLocalBackup !== 'function' || typeof local.importLocalBackup !== 'function') {
      throw new Error('This Dillo version does not expose local backup/restore. Upgrade create-dillo.');
    }
    const appId = flags['app-id'];
    if (args.operation === 'export') {
      const manifest = await local.exportLocalBackup({
        appId,
        databasePath: resolve(flags.database),
        filesDirectory: resolve(flags.files),
        outDirectory: resolve(flags.archive),
      }) as { format: string; appId: string; segments: unknown[]; secretsChecklist: unknown[] };
      if (!flags.json) {
        this.log(`Exported ${manifest.format} for ${manifest.appId} → ${resolve(flags.archive)}`);
        this.log(`Segments: ${manifest.segments.length}; secrets checklist: ${manifest.secretsChecklist.length}`);
      }
      return manifest;
    }
    const manifest = await local.importLocalBackup({
      appId,
      archiveDirectory: resolve(flags.archive),
      databasePath: resolve(flags.database),
      filesDirectory: resolve(flags.files),
    }) as { format: string; appId: string };
    if (!flags.json) {
      this.log(`Restored ${manifest.format} for ${manifest.appId} → database ${resolve(flags.database)}`);
      this.log('Re-login required. Recreate API keys listed in secrets-checklist.json.');
    }
    return manifest;
  }
}
