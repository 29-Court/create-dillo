import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { doctor, assertCloudflareCredentials } from './project.js';

// Pure command construction makes stage selection and local-state isolation testable.
export function workflowArguments({ command, stage, config, stack, envFile }: { command: string; stage?: string | undefined; config: string; stack?: string | undefined; envFile?: string | undefined }) {
 const allowed = ['dev', 'deploy', 'plan', 'list', 'stages', 'logs'];
 if (!allowed.includes(command)) throw new Error(`Choose ${allowed.join(', ')}.`);
 if (stage && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(stage)) throw new Error('Stage names may contain letters, numbers, hyphens, and underscores.');
 if (command === 'deploy' && !stage) throw new Error('Choose a deployment stage: npm run deploy -- dev (or your stage name).');
 if (command === 'dev' && stage && stage !== 'local') throw new Error('dev is local only. Use deploy <stage> for Cloudflare.');
 if (command === 'stages' && stage) throw new Error('stages lists all deployed stages; it does not take a stage name.');
 const selected = stage || (command === 'dev' ? 'local' : 'dev');
 const local = command === 'dev' || (command === 'list' && selected === 'local');
 if (!local && selected === 'local') throw new Error('local is reserved for development. Choose a cloud stage such as dev.');
 let args;
 if (command === 'list' || command === 'stages') {
  if (!stack) throw new Error('Set package.json armadillo.stack to the Alchemy stack name before listing resources.');
  args = ['state', command === 'list' ? 'resources' : 'stages', config, '--stack', stack + (local ? 'Local' : '')];
  if (command === 'list') args.push('--stage', selected);
  if (local) args.push('--local');
 } else args = [command, config, '--stage', selected];
 if (envFile) args.push('--env-file', envFile);
 return { args, local };
}

export async function runWorkflow(directory: string, command: string, stage: string | undefined, { dryRun = false, envFile }: { dryRun?: boolean; envFile?: string | undefined } = {}) {
 const project = await doctor(directory);
 const manifest = JSON.parse(await readFile(join(project.directory, 'package.json'), 'utf8'));
 const invocation = workflowArguments({ command, stage, config: project.config, stack: manifest.armadillo?.stack, envFile });
 const entry = resolve(dirname(project.alchemy), 'cli.js');
 if (dryRun) {
  console.log(JSON.stringify({ executable: process.execPath, args: [entry, ...invocation.args], cwd: project.directory, local: invocation.local }, null, 2));
  return;
 }
 // F-09: same fail-fast as workflow(); dryRun stays silent by design.
 await assertCloudflareCredentials(command);
 const result = spawnSync(process.execPath, [entry, ...invocation.args], {
  cwd: project.directory, stdio: 'inherit',
  env: { ...process.env, ALCHEMY_DEV: invocation.local ? 'true' : 'false' },
 });
 if (result.error) throw result.error;
 if (result.signal) throw new Error(`Alchemy ${command} stopped (${result.signal}).`);
 if (result.status) throw new Error(`Alchemy ${command} exited with status ${result.status}.`);
}
