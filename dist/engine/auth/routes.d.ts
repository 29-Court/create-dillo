import { type ArmadilloEnv } from "../environment.js";
import { type SchemaDefinition } from "../../schema.js";
export declare function authRoute(request: Request, env: ArmadilloEnv, currentAppId: string, action: string, schema?: SchemaDefinition): Promise<Response>;
