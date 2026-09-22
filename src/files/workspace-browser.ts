import {constants} from 'node:fs';
import {open,readdir,realpath,stat} from 'node:fs/promises';
import {posix,resolve,relative,isAbsolute,extname,join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Readable} from 'node:stream';
import {Client,type SFTPWrapper,type Stats as SftpStats} from 'ssh2';

export const WORKSPACE_READ_MAX=32*1024*1024;
const MAX_ENTRIES=20000;
export class WorkspaceBrowseError extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}
export interface FileInfo {kind:'file'|'directory'|'link'|'other';size:number;modifiedAt:number}
export interface DirectoryEntry extends FileInfo {name:string;path:string;readable:boolean;reason?:string}
export interface WorkspaceListing {path:string;entries:DirectoryEntry[];total:number;hasMore:boolean;nextOffset:number|null}
export interface BrowseFileSystem {
 realpath(path:string):Promise<string>;
 stat(path:string):Promise<FileInfo>;
 entries(path:string):Promise<Array<{name:string;info?:FileInfo;kind:FileInfo['kind']}>>;
 read(path:string,signal?:AbortSignal):Promise<Buffer>;
 join(root:string,path:string):string;
 within(root:string,path:string):boolean;
}
const blocked=(message='无法读取此位置。')=>new WorkspaceBrowseError(403,'outside_workspace',message);
export function normalizeBrowsePath(value:string):string {
 if(typeof value!=='string'||value.includes('\0')||value.includes('\\')||value.startsWith('/')||/^[a-z]:/i.test(value)||value.split('/').includes('..'))throw new WorkspaceBrowseError(400,'invalid_path','请使用工作区内的相对路径。');
 return value.split('/').filter(p=>p&&p!=='.').join('/');
}
export function protectedBrowsePath(path:string,original=false):boolean {
 const parts=path.split('/');const name=parts.at(-1)??'';
 return parts.includes('.ssh')||(original&&parts[0]==='ssh')||/^id_(rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i.test(name)||/\.(key|p12|pfx|ppk)$/i.test(name);
}
function privateKey(bytes:Buffer){return /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |SSH2 ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/m.test(bytes.toString('utf8'))||bytes.subarray(0,32).toString().startsWith('openssh-key-v1')||/^PuTTY-User-Key-File-[23]:/.test(bytes.subarray(0,80).toString());}
function tooLarge(){return new WorkspaceBrowseError(413,'file_too_large','文件超过 32 MB，请通过工作区工具读取或导出。');}
export async function collectRead(stream:Readable,signal?:AbortSignal):Promise<Buffer>{
 return new Promise((yes,no)=>{const chunks:Buffer[]=[];let size=0,settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);if(error){stream.destroy();no(error);}else yes(Buffer.concat(chunks,size));};const cancel=()=>finish(new WorkspaceBrowseError(499,'cancelled','读取已取消。'));if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});stream.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>WORKSPACE_READ_MAX){finish(tooLarge());return;}chunks.push(chunk);}).once('end',()=>finish()).once('error',error=>finish(error)).once('close',()=>{if(!settled)finish(new Error('File read closed before completion'));});});
}
function localInfo(s:Awaited<ReturnType<typeof stat>>):FileInfo{return {kind:s.isDirectory()?'directory':s.isFile()?'file':s.isSymbolicLink()?'link':'other',size:Number(s.size),modifiedAt:Number(s.mtimeMs)};}
export const localBrowseFs:BrowseFileSystem={
 realpath,stat:async path=>localInfo(await stat(path)),
 entries:async path=>(await readdir(path,{withFileTypes:true})).map(e=>({name:e.name,kind:e.isDirectory()?'directory':e.isFile()?'file':e.isSymbolicLink()?'link':'other'})),
 join:(root,path)=>resolve(root,path),within:(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');},
 read:async(path,signal)=>{const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat(),current=await stat(path);if(!opened.isFile()||opened.dev!==current.dev||opened.ino!==current.ino||await realpath(path)!==path)throw blocked();if(opened.size>WORKSPACE_READ_MAX)throw tooLarge();return await collectRead(handle.createReadStream({start:0,end:WORKSPACE_READ_MAX,autoClose:false}),signal);}finally{await handle.close();}},
};
function remoteInfo(s:SftpStats):FileInfo{return {kind:s.isDirectory()?'directory':s.isFile()?'file':s.isSymbolicLink()?'link':'other',size:s.size,modifiedAt:s.mtime*1000};}
export function sftpBrowseFs(sftp:SFTPWrapper):BrowseFileSystem {
 return {
  realpath:path=>new Promise((yes,no)=>sftp.realpath(path,(error,result)=>error?no(error):yes(result))),
  stat:path=>new Promise((yes,no)=>sftp.stat(path,(error,result)=>error?no(error):yes(remoteInfo(result)))),
  entries:path=>new Promise((yes,no)=>{sftp.readdir(path,(error,list)=>{if(error)no(error);else yes(list.map(e=>({name:e.filename,kind:remoteInfo(e.attrs).kind,info:remoteInfo(e.attrs)})));});}),
  join:(root,path)=>posix.join(root,path),within:(root,path)=>path===root||path.startsWith(root.endsWith('/')?root:root+'/'),
  read:(path,signal)=>collectRead(sftp.createReadStream(path,{start:0,end:WORKSPACE_READ_MAX}),signal),
 };
}
// Reuse OpenSSH's trust store, including hashed host names; never trust a new host silently.
export async function knownHostKeys(host:string,port:number,file=join(homedir(),'.ssh','known_hosts')):Promise<string[]> {
 try {const {stdout}=await promisify(execFile)('ssh-keygen',['-F',port===22?host:`[${host}]:${port}`,'-f',file],{timeout:3000,maxBuffer:1024*1024});return stdout.split('\n').filter(line=>line&&!line.startsWith('#')&&!line.startsWith('@')).map(line=>line.trim().split(/\s+/)[2]).filter(Boolean);}
 catch{return [];}
}
export async function withReadonlySftp<T>(config:{host:string;port:number;user:string;privateKey:string|Buffer;hostKeys:string[]},action:(fs:BrowseFileSystem)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!config.hostKeys.length)throw new WorkspaceBrowseError(502,'host_not_trusted','尚未确认远端主机身份，请先通过工作区终端确认 SSH 主机密钥。');
 const client=new Client();let timer:ReturnType<typeof setTimeout>|undefined;let abort:()=>void=()=>{};
 try {return await new Promise<T>((yes,no)=>{let settled=false;const fail=(error:unknown)=>{if(settled)return;settled=true;no(error instanceof WorkspaceBrowseError?error:new WorkspaceBrowseError(502,'workspace_unavailable','无法读取远端工作区，请检查 SSH 主机、账户和密钥。'));client.destroy();};abort=()=>fail(new WorkspaceBrowseError(499,'cancelled','读取已取消。'));if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>fail(new WorkspaceBrowseError(504,'workspace_timeout','远端工作区响应超时，请重试。')),15000);
  client.on('error',fail).on('close',()=>{if(!settled)fail(new Error('SSH connection closed'));}).on('ready',()=>client.sftp((error,sftp)=>{if(error){fail(error);return;}action(sftpBrowseFs(sftp)).then(value=>{if(!settled){settled=true;yes(value);}},fail);}));
  try{client.connect({host:config.host,port:config.port,username:config.user,privateKey:config.privateKey,readyTimeout:6000,hostVerifier:(key:Buffer)=>{const trusted=config.hostKeys.includes(key.toString('base64'));if(!trusted)fail(new WorkspaceBrowseError(502,'host_key_changed','远端主机密钥与已信任的记录不符，已停止连接。'));return trusted;}});}catch(error){fail(error);}
 });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);client.destroy();}
}
async function scopedPath(fs:BrowseFileSystem,root:string,path:string,original:boolean):Promise<string>{
 if(protectedBrowsePath(path,original))throw new WorkspaceBrowseError(403,'protected_file','私钥及 SSH 凭证目录不在浏览范围内。');
 const actual=await fs.realpath(fs.join(root,path));if(!fs.within(root,actual))throw blocked('此链接指向工作区以外，不能在这里打开。');
 if(protectedBrowsePath(actual.slice(root.length).replace(/^\//,''),original)||actual.split('/').includes('.ssh'))throw new WorkspaceBrowseError(403,'protected_file','私钥及 SSH 凭证目录不在浏览范围内。');return actual;
}
export async function listWorkspaceRoot(fs:BrowseFileSystem,rootPath:string,pathValue:string,original:boolean,offset=0,limit=200):Promise<WorkspaceListing>{
 const path=normalizeBrowsePath(pathValue),root=await fs.realpath(rootPath),actual=await scopedPath(fs,root,path,original),info=await fs.stat(actual);if(info.kind!=='directory')throw new WorkspaceBrowseError(400,'not_directory','这里不是文件夹。');
 const items=(await fs.entries(actual)).filter(e=>e.name!=='.'&&e.name!=='..'&&!e.name.includes('/')&&!e.name.includes('\\')&&!protectedBrowsePath([path,e.name].filter(Boolean).join('/'),original));
 if(items.length>MAX_ENTRIES)throw new WorkspaceBrowseError(413,'directory_too_large','此目录超过 20000 项，请通过工作区工具读取。');
 items.sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||a.name.localeCompare(b.name));
 const entries=await Promise.all(items.slice(offset,offset+limit).map(async item=>{const child=[path,item.name].filter(Boolean).join('/');try{const actual=await scopedPath(fs,root,child,original);const info=item.kind==='link'||!item.info?await fs.stat(actual):item.info;return {...info,name:item.name,path:child,readable:info.kind==='file'||info.kind==='directory'};}catch{return {name:item.name,path:child,kind:'link' as const,size:0,modifiedAt:0,readable:false,reason:'不可访问或超出工作区'};}}));
 const next=offset+entries.length;return {path,entries,total:items.length,hasMore:next<items.length,nextOffset:next<items.length?next:null};
}
export async function readWorkspaceRoot(fs:BrowseFileSystem,rootPath:string,pathValue:string,original:boolean,signal?:AbortSignal):Promise<{path:string;name:string;bytes:Buffer;mime:string}>{
 const path=normalizeBrowsePath(pathValue),root=await fs.realpath(rootPath),actual=await scopedPath(fs,root,path,original),info=await fs.stat(actual);if(info.kind!=='file')throw new WorkspaceBrowseError(400,'not_file','这里不是普通文件。');if(info.size>WORKSPACE_READ_MAX)throw tooLarge();
 const bytes=await fs.read(actual,signal);if(privateKey(bytes))throw new WorkspaceBrowseError(403,'protected_file','此文件包含私钥，不能在界面读取。');
 const types:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.pdf':'application/pdf','.html':'text/html','.htm':'text/html','.md':'text/markdown','.markdown':'text/markdown','.json':'application/json','.csv':'text/csv'};
 let mime=types[extname(path).toLowerCase()];if(!mime){try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);mime=bytes.includes(0)?'application/octet-stream':'text/plain';}catch{mime='application/octet-stream';}}
 return {path,name:posix.basename(path),bytes,mime};
}
