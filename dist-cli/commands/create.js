import { Command, Args, Flags } from "@oclif/core";
import { scaffold } from "../project.js";
class Create extends Command {
  static description = "Create a standalone Dillo application in a new directory";
  static enableJsonFlag = true;
  static args = { directory: Args.string({ required: true }) };
  static flags = { template: Flags.string({ options: ["minimal", "typed"], default: "minimal" }), install: Flags.boolean({ description: "Install application dependencies", default: false }) };
  async run() {
    const { args, flags } = await this.parse(Create);
    const result = await scaffold(args.directory, flags);
    if (!flags.json) this.log(`Created ${result.directory}. ${flags.install ? "Run npm run check." : "Run npm install, then npm run check in that directory."}`);
    return result;
  }
}
export {
  Create as default
};
