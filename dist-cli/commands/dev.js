import { Command, Args, Flags } from "@oclif/core";
import { workflow } from "../project.js";
class Workflow extends Command {
  static description = "Run the installed application Alchemy dev workflow";
  static args = { directory: Args.string({ default: "." }) };
  static flags = { stage: Flags.string({ description: "Alchemy stage" }) };
  async run() {
    const { args, flags } = await this.parse(Workflow);
    await workflow(args.directory, "dev", flags.stage);
  }
}
export {
  Workflow as default
};
