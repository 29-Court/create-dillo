import { Command, Args } from "@oclif/core";
import { doctor } from "../project.js";
class Doctor extends Command {
  static description = "Check application files, installed library compatibility, and Alchemy";
  static enableJsonFlag = true;
  static args = { directory: Args.string({ default: "." }) };
  async run() {
    const { args, flags } = await this.parse(Doctor);
    const result = await doctor(args.directory);
    if (!flags.json) this.log(`Dillo ${result.library}: project prerequisites pass. Run npm run check to validate application types and deployment declarations.`);
    return result;
  }
}
export {
  Doctor as default
};
