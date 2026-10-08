import { Command, Args, Flags } from "@oclif/core";
import { runWorkflow } from "../run-workflow.js";
class Run extends Command {
  static description = "Develop, deploy, and inspect a Dillo application through its installed Alchemy";
  static args = {
    operation: Args.string({ required: true, options: ["dev", "deploy", "plan", "list", "stages", "logs"] }),
    stage: Args.string({ description: "Cloud stage; dev is the default for reads/plans. local is reserved for local development." })
  };
  static flags = {
    directory: Flags.string({ default: ".", description: "Application directory" }),
    "env-file": Flags.string({ description: "Stage-specific environment file" }),
    "dry-run": Flags.boolean({ description: "Print command arguments without evaluating config or contacting Cloudflare" })
  };
  async run() {
    const { args, flags } = await this.parse(Run);
    await runWorkflow(flags.directory, args.operation, args.stage, { dryRun: flags["dry-run"], envFile: flags["env-file"] });
  }
}
export {
  Run as default
};
