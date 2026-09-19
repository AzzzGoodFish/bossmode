// Workspace and SSH HTTP adapters. Terminal processes stay agent-owned.
import { getMember } from "../member/identity.js";
import {
  createWorkspace,
  readMemberSshPublicKey,
  readWorkspaces,
  removeWorkspace,
  useWorkspace,
  type CreateWorkspaceArgs,
} from "../member/workspaces.js";
import { addRoute, parseBody, sendJson } from "./http.js";

function memberExists(id: string): boolean { return getMember(id) !== null; }

addRoute("GET", "/api/members/:id/workspaces", async (_request, response, params) => {
  if (!memberExists(params.id)) return sendJson(response, 404, { error: "member_not_found" });
  sendJson(response, 200, readWorkspaces(params.id));
});

addRoute("POST", "/api/members/:id/workspaces", async (request, response, params) => {
  if (!memberExists(params.id)) return sendJson(response, 404, { error: "member_not_found" });
  const body = await parseBody(request) as Partial<CreateWorkspaceArgs>;
  const result = createWorkspace(params.id, {
    id: String(body.id || ""),
    kind: body.kind as "ssh",
    description: body.description,
    host: String(body.host || ""),
    port: body.port,
    user: String(body.user || ""),
    keyPath: body.keyPath,
    root: body.root,
  });
  if (!result.ok) return sendJson(response, 400, { error: "invalid_workspace", message: result.error });
  sendJson(response, 201, { workspace: result.workspace });
});

addRoute("POST", "/api/members/:id/workspaces/:workspaceId/use", async (_request, response, params) => {
  if (!memberExists(params.id)) return sendJson(response, 404, { error: "member_not_found" });
  const result = useWorkspace(params.id, params.workspaceId);
  if (!result.ok) return sendJson(response, 404, { error: "workspace_not_found", message: result.error });
  sendJson(response, 200, result);
});

addRoute("DELETE", "/api/members/:id/workspaces/:workspaceId", async (_request, response, params) => {
  if (!memberExists(params.id)) return sendJson(response, 404, { error: "member_not_found" });
  const result = removeWorkspace(params.id, params.workspaceId);
  if (!result.ok) {
    const status = params.workspaceId === "original" ? 400 : 404;
    return sendJson(response, status, { error: status === 400 ? "builtin_workspace" : "workspace_not_found", message: result.error });
  }
  sendJson(response, 200, { ok: true });
});

addRoute("GET", "/api/members/:id/ssh-public-key", async (_request, response, params) => {
  if (!memberExists(params.id)) return sendJson(response, 404, { error: "member_not_found" });
  sendJson(response, 200, { publicKey: readMemberSshPublicKey(params.id) });
});
