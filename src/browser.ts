import { Armadillo, ArmadilloError } from "./client.js";

/**
 * The browser-script entrypoint deliberately has no application code. Adapters
 * serve this at `/armadillo/client.js`, after injecting public deployment
 * metadata, so a plain `<script>` can call `Armadillo()` immediately.
 */
Object.assign(globalThis, { Armadillo, ArmadilloError });
