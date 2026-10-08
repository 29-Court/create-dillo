import { build } from 'esbuild';
await build({ entryPoints: [new URL('./ui/main.ts', import.meta.url).pathname], outfile: new URL('./public/app.js', import.meta.url).pathname, bundle: true, platform: 'browser', target: 'es2022', sourcemap: true });
