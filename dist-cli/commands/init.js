import { Command, Args, Flags } from "@oclif/core";
import { scaffold } from "../project.js";
class Init extends Command {
  static description = "Add Dillo files to an existing directory without overwriting application code";
  static enableJsonFlag = true;
  static args = { directory: Args.string({ default: "." }) };
  static flags = { template: Flags.string({ options: ["minimal", "typed"], default: "minimal" }), install: Flags.boolean({ default: false }) };
  async run() {
    const { args, flags } = await this.parse(Init);
    const result = await scaffold(args.directory, { ...flags, init: true });
    if (!flags.json) this.log(`Initialized ${result.directory}. Run npm install, then npm run check.`);
    return result;
  }
}
export {
  Init as default
};
