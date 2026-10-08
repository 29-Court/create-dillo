<p align="center">
  <img src="https://muse.ai/files/715482231644541/1784268249514476/fyswfdddsor42jl304g6wc7g/21a168bb2f9ce0ebf92a81742edd9a239e1380381606aa8440ea6436e5fbb401.png" alt="Armadillo — Armored backend." width="400">
</p>

<h1 align="center">DILLO</h1>
<p align="center"><strong>Your backend, built to take a hit.</strong></p>

<p align="center">
  Files, database, functions — described in three files,<br>
  deployed to Cloudflare, armored by default.
</p>

<p align="center">
  <a href="https://dillo.29court.com">dillo.29court.com</a> •
  <a href="https://hackthedillo.dev">hackthedillo.dev</a> •
  <a href="https://github.com/29-Court/create-dillo">GitHub</a>
</p>

---

## Install

```bash
npm init create-dillo@alpha
```

One command. Three files. Zero weeks spent wiring auth.

## The three files

**`schema.ts`** — what your data looks like. Who can touch it.

```ts
import { boolean, owner, schema, string, table } from "create-dillo/schema";

export default schema({
  Project: table({
    name: string().min(1).max(120),
    active: boolean().default(true),
  }).permissions({
    view: owner,   // the armor: enforced on every request
    edit: owner,
  }),
});
```

**`backend.ts`** — what your app does. Functions, validated.

```ts
import { defineBackend, defineFunction } from "create-dillo/backend";

export default defineBackend({
  schema,
  functions: {
    greet: defineFunction()
      .input({ name: string().min(1) })
      .output({ message: string() })
      .handler((_ctx, input) => ({ message: `Hello ${input.name}` })),
  },
});
```

**`armadillo.config.ts`** — where it runs. Your infrastructure.

```ts
import { app } from "create-dillo/deploy/cloudflare";
import backend from "./backend.ts";

export default app({ id: "my-app", backend, signup: "open" });
// Workers + D1 + R2, wired. Deploy when you're ready.
```

## Client — types flow to your UI

```ts
import { createClient } from "create-dillo/client";
import type { Project } from "./schema.ts";  // same types, shared

const api = createClient({ baseUrl: "/api" });

// Fully typed — Project comes straight from your schema.
const projects: Project[] = await api.list("projects");
const { message } = await api.functions.greet({ name: "Victor" });
// Change the schema? The client breaks at build time, not runtime.
```

## What is a dillo?

**A dillo is a box.** Your box. Everything your app needs to exist lives inside it — and every wall of the box can be swapped, expanded, or ripped out. Your call.

- **Wall one: Files** — Powered by R2 by default. Uploads, storage, and access rules that respect the same permission words as everything else.
- **Wall two: Database** — Powered by D1 by default. JSON records with real types flowing straight to your client.
- **Wall three: Functions** — Your logic, at the edge. `defineFunction()` — validated inputs, typed outputs, callable straight from your UI.
- **Wall four: Micro-apps** *(roadmap)* — AI-built apps living on top of your dillo.

## The deal

**We take the *entire* backend. You do whatever you want on the frontend.**

- **Permissions:** The backend holds all the permissions. Every record, every file, every function call runs through the armor.
- **Ownership:** Your data is yours. Private by default, on infrastructure you control.
- **Responsibility:** Ship the dumb stuff. Break your own data? That's on you. But the backend will never be the thing that breaks first.
- **Frontend:** No approval needed. For anything.

## Proof of armor, courtesy of Texas

In July 2015, a man in Marietta, Texas spotted an armadillo on his property at 3 a.m., took out a .38 revolver, and fired three times. **One of the bullets came back and hit him in the jaw.** He was airlifted to a hospital.

> "We didn't find the armadillo."
> — Sheriff Larry Rowe, Cass County, on the condition of the animal

## License

MIT. Built to take a hit.
