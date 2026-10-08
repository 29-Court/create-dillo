#!/usr/bin/env node
import { execute } from "@oclif/core";
const args = process.argv.slice(2);
if (args[0] && !args[0].startsWith("-") && !["create", "init", "doctor", "dev", "plan", "deploy", "run", "backup", "help"].includes(args[0])) args.unshift("create");
await execute({ dir: import.meta.url, args });
