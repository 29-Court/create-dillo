import { type ArmadilloEnv } from "./environment.js";
export declare function bridgeJoinRoute(request: Request, env: ArmadilloEnv, appId: string, token: string): Promise<Response>;
export declare function bridgeRoute(request: Request, env: ArmadilloEnv, appId: string, segments: string[]): Promise<Response>;
