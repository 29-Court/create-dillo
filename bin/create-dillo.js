#!/usr/bin/env node
// create-dillo — the one-command way to start a dillo app.
// Zero dependencies. Random armadillo every time.
"use strict";

const fs = require("fs");
const path = require("path");

const ART = [
`          ___
       .-"   "-.
      /  _____  \\
     |  |     |  |
     |  | (o) |  |
      \\  \\___/  /
       '._____.'
     _/           \\_
    /  '.       .'  \\
   |     '.___.'     |
    \\               /
     '.___________.'`,

`                    _
                 .-" "-.
                / .---. \\
               |  |o o|  |
                \\  \\_/  /
           __    '-----'    __
          /  \\             /  \\
         |    '.  __  __ .'    |
          \\     ./  \\/  \\.     /
           '.   |  __  __  |   .'
             '--'  '--'  '--'`,

`         ,--.
        /    \\
       |  ◕ ◕  |
        \\  --  /
    ____/    \\____
   / |  |  |  |  | \\
  |  |  |  |  |  |  |
   \\_|__|__|__|__/
         |  |
        _|  |_
       (      )
        '----'`,

`      ____
   .-"    "-.
  /  .----.  \\
 |  /  __  \\  |
  \\ | (o)(o) | /
   \\ \\  __  / /
    '. '----' .'
      '------'
   __/        \\__
  /  \\        /  \\
 ~    '------'    ~`
];

const TAGLINES = [
  "Your backend, built to take a hit.",
  "Small. Armored. Ships.",
  "Private by default. Public on purpose.",
  "Rolls up. Rolls out."
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scaffold(dir) {
  const root = path.resolve(process.cwd(), dir);
  if (fs.existsSync(root)) {
    console.error(`\n  ./${dir} already exists — pick another name.`);
    process.exit(1);
  }
  fs.mkdirSync(root, { recursive: true });

  const pkg = {
    name: dir,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "node index.js",
      check: "node --check index.js && echo 'OK'"
    },
    dependencies: {
      "@29court/dillo": "alpha"
    }
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  fs.writeFileSync(path.join(root, "index.js"),
`// ${dir} — a dillo app.
// Docs: https://github.com/29-Court/create-dillo

console.log("dillo is awake. Your API is private by default.");
console.log("Declare what is public, and auth fails closed.");
`);

  fs.writeFileSync(path.join(root, "README.md"),
`# ${dir}

A dillo app. Private by default, public on purpose.

\`\`\`bash
npm install
npm run dev
\`\`\`

\`npm run check\` validates the app before it ships.
`);
  return root;
}

function main() {
  const name = process.argv[2] || "my-dillo-app";
  console.log("");
  console.log(pick(ART));
  console.log("");
  console.log("  " + pick(TAGLINES));
  console.log("");
  const root = scaffold(name);
  console.log(`  Created ${root}`);
  console.log("");
  console.log("  Next:");
  console.log(`    cd ${name}`);
  console.log("    npm install");
  console.log("    npm run dev");
  console.log("");
}

main();
