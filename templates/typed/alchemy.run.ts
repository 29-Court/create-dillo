import { app } from "create-dillo/deploy/cloudflare";
import backend from "./backend.ts";

export default app({ id: "my-app", backend, signup: "open" });
