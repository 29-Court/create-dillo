import { type InternalGroupMembershipRow } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type InternalGroupMemberUserRow } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloGroupMembership } from "../backend.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
export declare function groupJson(row: InternalGroupMembershipRow): JsonObject;
/** Insert a non-owner membership. A row that already exists keeps its role. */
export declare function grantMembership(env: ArmadilloEnv, appId: string, groupId: string, userId: string, role: string): Promise<{
    role: string;
}>;
export declare function memberJson(row: InternalGroupMemberUserRow): JsonObject;
export declare function membershipsFor(env: ArmadilloEnv, currentAppId: string, userId: string): Promise<ArmadilloGroupMembership[]>;
export declare function requireGroupMembership(env: ArmadilloEnv, currentAppId: string, groupId: string, userId: string, roles?: readonly string[]): Promise<{
    role: string;
}>;
export declare function requireTeamPolicy(env: ArmadilloEnv, currentAppId: string, teamSlug: string, userId: string, roles?: readonly string[]): Promise<{
    id: string;
    role: string;
}>;
export declare function configuredTeam(env: ArmadilloEnv, currentAppId: string, teamSlug: string): Promise<{
    id: string;
    created_by: string;
}>;
export declare function groupsRoute(request: Request, env: ArmadilloEnv, currentAppId: string, options: ArmadilloBackendDefinition, groupId?: string, action?: string, trustedCreate?: boolean, memberId?: string): Promise<Response>;
