import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {getMember} from './identity.js';
import {getWorkspace,memberSshKeyPath,readSshCredential} from './workspaces.js';
import {memberDir} from '../files/layout.js';
import {knownHostKeys,localBrowseFs,withReadonlySftp,WorkspaceBrowseError,type BrowseFileSystem} from '../files/workspace-browser.js';

function browseError(error:unknown):WorkspaceBrowseError {
 if(error instanceof WorkspaceBrowseError)return error;
 const code=(error as {code?:string|number})?.code;
 if(code==='ENOENT'||code==='ENOTDIR'||code===2)return new WorkspaceBrowseError(404,'not_found','文件或目录已不存在，请刷新后重试。');
 if(code==='EACCES'||code==='EPERM'||code===3)return new WorkspaceBrowseError(403,'permission_denied','没有读取这个文件或目录的权限。');
 return new WorkspaceBrowseError(502,'workspace_unavailable','无法读取工作区，请检查连接或目录权限后重试。');
}
/** The HTTP caller supplies IDs, never a machine, key, or absolute root. */
export async function browseMemberWorkspace<T>(memberId:string,workspaceId:string,action:(fs:BrowseFileSystem,root:string,original:boolean)=>Promise<T>,signal?:AbortSignal):Promise<T> {
 if(!getMember(memberId))throw new WorkspaceBrowseError(404,'member_not_found','成员不存在。');
 const workspace=getWorkspace(memberId,workspaceId);
 if(!workspace)throw new WorkspaceBrowseError(404,'workspace_not_found','此工作区未登记或已移除。');
 try {
  if(workspace.kind==='original')return await action(localBrowseFs,workspace.root,true);
  const keyPath=workspace.keyPath.startsWith('~/')?resolve(homedir(),workspace.keyPath.slice(2)):resolve(memberDir(memberId),workspace.keyPath);
  const privateKey=keyPath===memberSshKeyPath(memberId)?readSshCredential(memberId)?.privateKey:await readFile(keyPath);
  if(!privateKey)throw new WorkspaceBrowseError(502,'missing_ssh_key','没有可用的 SSH 密钥。');
  const hostKeys=await knownHostKeys(workspace.host,workspace.port);
  return await withReadonlySftp({...workspace,privateKey,hostKeys},async fs=>{
   try {const root=workspace.root==='~'?await fs.realpath('.'):workspace.root.startsWith('~/')?fs.join(await fs.realpath('.'),workspace.root.slice(2)):workspace.root;return await action(fs,root,false);}
   catch(error){throw browseError(error);}
  },signal);
 }catch(error){throw browseError(error);}
}
