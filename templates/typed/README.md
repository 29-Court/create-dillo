# Typed Dillo application

`schema.ts` infers Project fields, and `backend.ts` declares the validated greet function. `client.ts` uses a type-only backend import for typed function calls and demonstrates schema inference and expected compile failures. Its negative fixtures are compile-only and must not be executed.

`alchemy.run.ts` is the shared Cloudflare recipe. Install the published alpha (`npm install create-dillo@alpha`), then `npm run check` and `npm run dev`. See [release](../../docs/release.md) before deploying cloud resources.

`npm run dev` (`alchemy dev`) needs Cloudflare credentials — run `alchemy login` first, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Without them authentication fails and the dev session parks instead of exiting.
