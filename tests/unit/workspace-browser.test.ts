import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rm,truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable,PassThrough} from 'node:stream';
import {localBrowseFs,listWorkspaceRoot,readWorkspaceRoot,normalizeBrowsePath,WORKSPACE_READ_MAX,collectRead,withReadonlySftp} from '../../src/files/workspace-browser.js';
const roots:string[]=[];afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function fixture(){const parent=await mkdtemp(join(tmpdir(),'bm-workspace-browser-'));roots.push(parent);const root=join(parent,'root');await mkdir(root);return {parent,root};}
it('rejects absolute, parent, NUL and Windows paths, while allowing UTF-8 names',()=>{
 for(const path of ['../x','a/../x','/etc/passwd','C:/x','a\\b','a\0b'])expect(()=>normalizeBrowsePath(path)).toThrow();
 expect(normalizeBrowsePath('./子目录//文档.md')).toBe('子目录/文档.md');
});
it('lists directories first with pagination and reads exact bytes and MIME without writes',async()=>{
 const {root}=await fixture();await mkdir(join(root,'nested'));await writeFile(join(root,'a.md'),'# 工作区\n');await writeFile(join(root,'b.bin'),Buffer.from([0,1,2]));
 const page=await listWorkspaceRoot(localBrowseFs,root,'',true,0,2);expect(page.entries.map(e=>e.name)).toEqual(['nested','a.md']);expect(page.hasMore).toBe(true);expect(page.nextOffset).toBe(2);
 const last=await listWorkspaceRoot(localBrowseFs,root,'',true,2,2);expect(last.entries.map(e=>e.name)).toEqual(['b.bin']);expect(last.hasMore).toBe(false);
 const md=await readWorkspaceRoot(localBrowseFs,root,'a.md',true);expect(md.bytes.toString()).toBe('# 工作区\n');expect(md.mime).toBe('text/markdown');expect((await readWorkspaceRoot(localBrowseFs,root,'b.bin',true)).mime).toBe('application/octet-stream');
});
it('permits internal links, marks outside and broken links unavailable, blocks reads and link directories outside',async()=>{
 const {parent,root}=await fixture();await writeFile(join(root,'in.txt'),'inside');await writeFile(join(parent,'out.txt'),'outside');await symlink(join(root,'in.txt'),join(root,'inside'));await symlink(join(parent,'out.txt'),join(root,'outside'));await symlink(parent,join(root,'outside-dir'));await symlink('missing',join(root,'broken'));
 const list=await listWorkspaceRoot(localBrowseFs,root,'',true);for(const name of ['outside','outside-dir','broken'])expect(list.entries.find(e=>e.name===name)?.readable).toBe(false);
 expect((await readWorkspaceRoot(localBrowseFs,root,'inside',true)).bytes.toString()).toBe('inside');await expect(readWorkspaceRoot(localBrowseFs,root,'outside',true)).rejects.toMatchObject({status:403});await expect(listWorkspaceRoot(localBrowseFs,root,'outside-dir',true)).rejects.toMatchObject({status:403});
});
it('hides named keys and SSH directories; blocks renamed and linked private keys by content',async()=>{
 const {root}=await fixture();await mkdir(join(root,'ssh'));await mkdir(join(root,'.ssh'));await writeFile(join(root,'id_ed25519'),'secret');await writeFile(join(root,'renamed.txt'),'header\n-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n');await symlink(join(root,'ssh'),join(root,'credentials-link'));await writeFile(join(root,'cert.pem'),'-----BEGIN CERTIFICATE-----\npublic');
 const list=await listWorkspaceRoot(localBrowseFs,root,'',true);expect(list.entries.some(e=>['ssh','.ssh','id_ed25519'].includes(e.name))).toBe(false);expect(list.entries.find(e=>e.name==='credentials-link')?.readable).toBe(false);
 for(const name of ['id_ed25519','renamed.txt'])await expect(readWorkspaceRoot(localBrowseFs,root,name,true)).rejects.toMatchObject({code:'protected_file'});
 expect((await readWorkspaceRoot(localBrowseFs,root,'cert.pem',true)).bytes.toString()).toContain('CERTIFICATE');
});
it('rejects oversize files and bounds a growing stream, aborting outstanding reads',async()=>{
 const {root}=await fixture();const file=join(root,'big.txt');await writeFile(file,'');await truncate(file,WORKSPACE_READ_MAX+1);await expect(readWorkspaceRoot(localBrowseFs,root,'big.txt',true)).rejects.toMatchObject({status:413});
 await expect(collectRead(Readable.from([Buffer.alloc(WORKSPACE_READ_MAX),Buffer.from('x')]))).rejects.toMatchObject({status:413});
 const abort=new AbortController(),stream=new PassThrough(),pending=collectRead(stream,abort.signal);abort.abort();await expect(pending).rejects.toMatchObject({code:'cancelled'});expect(stream.destroyed).toBe(true);
});
it('does not open an untrusted SSH host',async()=>{await expect(withReadonlySftp({host:'127.0.0.1',port:1,user:'test',privateKey:'not-a-key',hostKeys:[]},async()=>true)).rejects.toMatchObject({code:'host_not_trusted'});});
