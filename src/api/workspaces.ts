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
import { addRoute, parseBody, requestUrl, sendJson } from "./http.js";
import {browseMemberWorkspace} from '../member/workspace-files.js';
import {listWorkspaceRoot,readWorkspaceRoot,normalizeBrowsePath,WorkspaceBrowseError} from '../files/workspace-browser.js';

function memberExists(id: string): boolean { return getMember(id) !== null; }

for(const operation of ['files','file'] as const)addRoute('GET',`/api/members/:id/workspaces/:workspaceId/${operation}`,async(request,response,params)=>{
 const abort=new AbortController();const cancel=()=>abort.abort();response.once('close',cancel);
 response.setHeader('Cache-Control','no-store');
 try {
  const query=requestUrl(request).searchParams;
  if([...query.keys()].some(key=>!['path',...(operation==='files'?['offset','limit']:[])].includes(key)))throw new WorkspaceBrowseError(400,'invalid_request','仅支持工作区内的相对路径。');
  const path=normalizeBrowsePath(query.get('path')??'');
  if(operation==='files'){
   const number=(key:string,fallback:number,max:number)=>{const raw=query.get(key);if(raw===null)return fallback;const value=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<0||value>max)throw new WorkspaceBrowseError(400,'invalid_page','无效的目录分页参数。');return value;};
   const offset=number('offset',0,20000),limit=number('limit',200,500);if(!limit)throw new WorkspaceBrowseError(400,'invalid_page','分页数量必须大于零。');
   const listing=await browseMemberWorkspace(params.id,params.workspaceId,(fs,root,original)=>listWorkspaceRoot(fs,root,path,original,offset,limit),abort.signal);
   if(!response.destroyed)sendJson(response,200,listing);
  }else{
   const file=await browseMemberWorkspace(params.id,params.workspaceId,(fs,root,original)=>readWorkspaceRoot(fs,root,path,original,abort.signal),abort.signal);
   if(!response.destroyed){response.writeHead(200,{'Content-Type':file.mime,'Content-Length':file.bytes.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});response.end(file.bytes);}
  }
 }catch(error){if(!response.destroyed){const e=error instanceof WorkspaceBrowseError?error:new WorkspaceBrowseError(502,'workspace_unavailable','暂时无法读取工作区，请重试。');sendJson(response,e.status,{error:e.message,code:e.code});}}
 finally{response.off('close',cancel);}
});

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
