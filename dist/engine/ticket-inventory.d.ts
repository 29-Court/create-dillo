import { type SchemaDefinition } from "../schema.js";
import { type ArmadilloEnv } from "./environment.js";
export declare function ticketInventoryRoute(request: Request, env: ArmadilloEnv, appId: string, collection: string, action: "issue" | "consume", definition: SchemaDefinition | undefined): Promise<Response>;
