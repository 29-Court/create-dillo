import { app } from "create-dillo/deploy/cloudflare";
import backend from "./backend.ts";

export default app({ id: "minimal", backend, signup: "open", assets: { directory: "./public" } });
