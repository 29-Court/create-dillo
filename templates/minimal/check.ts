import { validateCloudflareBackend, buildCloudflareWorker } from "create-dillo/deploy/cloudflare";
import backend from "./backend.ts";
validateCloudflareBackend(backend);
buildCloudflareWorker();
console.log("Application declarations are valid for Cloudflare.");
