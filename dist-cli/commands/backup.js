import { Command, Args, Flags } from "@oclif/core";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { doctor } from "../project.js";
class Backup extends Command {
  static description = "Export or restore a local Dillo SQLite/files backup";
  static enableJsonFlag = true;
  static args = {
    operation: Args.string({ required: true, options: ["export", "restore"] })
  };
  static flags = {
    directory: Flags.string({ default: ".", description: "Application directory (for library resolution)" }),
    "app-id": Flags.string({ required: true, description: "Application id" }),
    database: Flags.string({ required: true, description: "Path to state.sqlite" }),
    files: Flags.string({ required: true, description: "Path to local files directory" }),
    archive: Flags.string({ required: true, description: "Backup archive directory" })
  };
  async run() {
    const { args, flags } = await this.parse(Backup);
    await doctor(flags.directory);
    const require2 = createRequire(resolve(flags.directory, "package.json"));
    let local;
    try {
      local = require2("create-dillo/local");
    } catch {
      throw new Error("Dillo local adapter is not installed. Run npm install in the application.");
    }
    if (typeof local.exportLocalBackup !== "function" || typeof local.importLocalBackup !== "function") {
      throw new Error("This Dillo version does not expose local backup/restore. Upgrade create-dillo.");
    }
    const appId = flags["app-id"];
    if (args.operation === "export") {
      const manifest2 = await local.exportLocalBackup({
        appId,
        databasePath: resolve(flags.database),
        filesDirectory: resolve(flags.files),
        outDirectory: resolve(flags.archive)
      });
      if (!flags.json) {
        this.log(`Exported ${manifest2.format} for ${manifest2.appId} \u2192 ${resolve(flags.archive)}`);
        this.log(`Segments: ${manifest2.segments.length}; secrets checklist: ${manifest2.secretsChecklist.length}`);
      }
      return manifest2;
    }
    const manifest = await local.importLocalBackup({
      appId,
      archiveDirectory: resolve(flags.archive),
      databasePath: resolve(flags.database),
      filesDirectory: resolve(flags.files)
    });
    if (!flags.json) {
      this.log(`Restored ${manifest.format} for ${manifest.appId} \u2192 database ${resolve(flags.database)}`);
      this.log("Re-login required. Recreate API keys listed in secrets-checklist.json.");
    }
    return manifest;
  }
}
export {
  Backup as default
};
