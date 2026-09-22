import {expect,it} from 'vitest';
import {Server,utils,type Connection} from 'ssh2';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,realpath,stat,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withReadonlySftp,listWorkspaceRoot,readWorkspaceRoot,knownHostKeys} from '../../src/files/workspace-browser.js';
// A real SSH + SFTP wire connection; only the remote host is an isolated fixture.
it('verifies the host, reads and paginates over SFTP, blocks escaped links and keys, and cancels connections',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bm-readonly-sftp-')),host=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}).toString(),publicKey=utils.parseKey(host);if(publicKey instanceof Error)throw publicKey;
 const hostKeys=[publicKey.getPublicSSH().toString('base64')],clients=new Set<Connection>(),operations:string[]=[];
 const server=new Server({hostKeys:[host]},client=>{clients.add(client);client.on('error',()=>{}).on('close',()=>clients.delete(client)).on('authentication',ctx=>ctx.accept()).on('ready',()=>client.on('session',accept=>{const session=accept();session.on('sftp',accept=>{
  const sftp=accept(),handles=new Map<string,{path:string;listed?:boolean}>();let counter=0;
  const attrs=(s:Awaited<ReturnType<typeof stat>>)=>({mode:Number(s.mode),uid:Number(s.uid),gid:Number(s.gid),size:Number(s.size),atime:Math.floor(Number(s.atimeMs)/1000),mtime:Math.floor(Number(s.mtimeMs)/1000)});
  const reply=(id:number,fn:()=>Promise<void>)=>void fn().catch(()=>sftp.status(id,2));
  sftp.on('REALPATH',(id,path)=>{operations.push('REALPATH');reply(id,async()=>{const actual=await realpath(path==='.'?root:path);sftp.name(id,[{filename:actual,longname:actual,attrs:attrs(await stat(actual))}]);});});
  sftp.on('STAT',(id,path)=>{operations.push('STAT');reply(id,async()=>{sftp.attrs(id,attrs(await stat(path)));});});
  sftp.on('OPENDIR',(id,path)=>{operations.push('OPENDIR');const handle=String(++counter);handles.set(handle,{path});sftp.handle(id,Buffer.from(handle));});
  sftp.on('READDIR',(id,handle)=>{operations.push('READDIR');reply(id,async()=>{const target=handles.get(handle.toString())!;if(target.listed){sftp.status(id,1);return;}target.listed=true;sftp.name(id,await Promise.all((await readdir(target.path)).map(async name=>({filename:name,longname:name,attrs:attrs(await stat(join(target.path,name)))}))));});});
  sftp.on('OPEN',(id,path,flags)=>{operations.push('OPEN');if(flags!==1){sftp.status(id,3);return;}const handle=String(++counter);handles.set(handle,{path});sftp.handle(id,Buffer.from(handle));});
  sftp.on('READ',(id,handle,offset,length)=>{operations.push('READ');reply(id,async()=>{const content=await readFile(handles.get(handle.toString())!.path);if(offset>=content.length)sftp.status(id,1);else sftp.data(id,content.subarray(offset,offset+length));});});
  sftp.on('FSTAT',(id,handle)=>reply(id,async()=>{sftp.attrs(id,attrs(await stat(handles.get(handle.toString())!.path)));}));
  sftp.on('CLOSE',(id,handle)=>{operations.push('CLOSE');handles.delete(handle.toString());sftp.status(id,0);});
 });}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const config={host:'127.0.0.1',port,user:'fixture',privateKey:host,hostKeys};
 try {
  await mkdir(join(root,'project'));await writeFile(join(root,'project','readme.md'),'# SFTP fixture\n');await writeFile(join(root,'project','renamed-key.txt'),'-----BEGIN PRIVATE KEY-----\nfixture');await writeFile(join(root,'outside.txt'),'not in registered workspace');await symlink(join(root,'outside.txt'),join(root,'project','outside-link'));
  const known=join(root,'known_hosts');await writeFile(known,`[127.0.0.1]:${port} ssh-rsa ${hostKeys[0]}\n`);expect(await knownHostKeys('127.0.0.1',port,known)).toEqual(hostKeys);
  const listing=await withReadonlySftp(config,fs=>listWorkspaceRoot(fs,join(root,'project'),'',false,0,2));expect(listing.hasMore).toBe(true);expect(listing.entries.find(e=>e.name==='outside-link')?.readable).toBe(false);
  const file=await withReadonlySftp(config,fs=>readWorkspaceRoot(fs,join(root,'project'),'readme.md',false));expect(file.bytes.toString()).toBe('# SFTP fixture\n');
  await expect(withReadonlySftp(config,fs=>readWorkspaceRoot(fs,join(root,'project'),'outside-link',false))).rejects.toMatchObject({status:403});
  await expect(withReadonlySftp(config,fs=>readWorkspaceRoot(fs,join(root,'project'),'renamed-key.txt',false))).rejects.toMatchObject({code:'protected_file'});
  await expect(withReadonlySftp({...config,hostKeys:['wrong']},async()=>true)).rejects.toMatchObject({code:'host_key_changed'});
  const abort=new AbortController(),pending=withReadonlySftp(config,()=>new Promise(()=>{}),abort.signal);setTimeout(()=>abort.abort(),50);await expect(pending).rejects.toMatchObject({code:'cancelled'});
  expect(operations).toContain('READ');expect(operations.every(op=>['REALPATH','STAT','OPENDIR','READDIR','OPEN','READ','CLOSE'].includes(op))).toBe(true);
 }finally{for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
},15000);
