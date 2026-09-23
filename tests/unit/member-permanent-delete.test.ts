import {describe,it,expect} from 'vitest';
import {existsSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createTestServer,getTestBossmodeDir,jsonRequest,setupTestWorkspace} from '../helpers/test-server.js';
setupTestWorkspace();
describe('permanent member deletion',()=>{
 it('removes only member-owned data; preserves external workspaces, other members and group messages',async()=>{
  const s=await createTestServer();try{
   const token=JSON.parse((await jsonRequest(s.port,'POST','/api/auth/login',{body:{username:'testuser',password:'testpass'}})).body).token;
   const create=async(name:string)=>JSON.parse((await jsonRequest(s.port,'POST','/api/members',{token,body:{name}})).body).member.id as string;
   const id=await create('Delete owner'),other=await create('Keep owner');
   const room=JSON.parse((await jsonRequest(s.port,'POST','/api/rooms',{token,body:{name:'Keep this group',memberIds:[id,other]}})).body);
   const root=getTestBossmodeDir(),external=join(root,'external-project-kept');mkdirSync(external);writeFileSync(join(external,'keep.txt'),'external sentinel');
   const home=join(root,'members',id);writeFileSync(join(home,'private.txt'),'member only');symlinkSync(external,join(home,'external-link'));
   const {getDatabase}=await import('../../src/data/database.js'),db=getDatabase();
   const {readWorkspaces,importWorkspaceRegistry}=await import('../../src/member/workspaces.js');const registry=readWorkspaces(id);
   importWorkspaceRegistry(id,{...registry,workspaces:[...registry.workspaces,{id:'external',kind:'ssh',description:'local SSH project',host:'127.0.0.1',user:'nobody',port:22,keyPath:'/external/key',root:external} as any,{id:'remote',kind:'ssh',description:'remote project',host:'do-not-connect.invalid',user:'nobody',root:'/external/project',port:22,keyPath:'/external/key'} as any]});
   const {appendMessageInTransaction}=await import('../../src/chat/messages.js');
   const kept=db.transaction(tx=>appendMessageInTransaction(tx,`room:${room.id}`,{sender:'Delete owner',senderMemberId:id,content:'Keep my group history',mentions:[]}));
   db.transaction(tx=>appendMessageInTransaction(tx,`dm:${id}`,{sender:'user',content:'Delete this private chat',mentions:[]}));
   const {ensureMmScope,mmScopeIdOf}=await import('../../src/chat/conversations.js');ensureMmScope(id,other);const mm=mmScopeIdOf(id,other);
   db.transaction(tx=>appendMessageInTransaction(tx,mm,{sender:'Delete owner',senderMemberId:id,content:'Private member chat',mentions:[]}));
   const mmDir=join(root,'member-chats',mm.slice(3));mkdirSync(mmDir,{recursive:true});writeFileSync(join(mmDir,'private.txt'),'mm attachment');
   const roomFile=join(root,'rooms',room.id,'keep.txt');writeFileSync(roomFile,'group sentinel');
   for(const member of [id,other])db.run('INSERT INTO token_usage_daily VALUES(?,?,?,?,?,?,?,?,?)',member,'2026-09-22','fixture',11,22,33,44,0.1,1);
   const no=await jsonRequest(s.port,'DELETE',`/api/members/${id}`,{token,body:{confirm:false}});expect(no.status).toBe(400);expect(existsSync(home)).toBe(true);
   const deleted=await jsonRequest(s.port,'DELETE',`/api/members/${id}`,{token,body:{confirm:true}});expect(deleted.status,deleted.body).toBe(200);expect(JSON.parse(deleted.body)).toEqual({deleted:id});
   expect(existsSync(home)).toBe(false);expect(existsSync(mmDir)).toBe(false);expect(readFileSync(join(external,'keep.txt'),'utf8')).toBe('external sentinel');expect(readFileSync(roomFile,'utf8')).toBe('group sentinel');expect(existsSync(join(root,'members',other))).toBe(true);
   for(const table of ['members','current_sessions','queued_inputs','execution_attempts','agent_events','member_statistics','token_usage_daily','runtime_checkpoints','workspace_registries','workspaces','ssh_credentials','member_archives','member_archive_intents'])expect(db.get(`SELECT 1 FROM ${table} WHERE ${table==='members'?'id':'member_id'}=?`,id),table).toBeUndefined();
   expect(db.get('SELECT 1 FROM token_usage_daily WHERE member_id=?',other)).toBeDefined();expect(db.get('SELECT 1 FROM scopes WHERE id=?',`dm:${id}`)).toBeUndefined();expect(db.get('SELECT 1 FROM scopes WHERE id=?',mm)).toBeUndefined();
   expect(db.get('SELECT content FROM messages WHERE scope_id=? AND id=?',room.id,kept.id)).toEqual({content:'Keep my group history'});
   const fetched=await jsonRequest(s.port,'GET',`/api/conversations/${encodeURIComponent(`room:${room.id}`)}/messages`,{token});expect(fetched.status).toBe(200);expect(JSON.parse(fetched.body).messages.find((m:{id:string})=>m.id===kept.id).sender).toBe('Delete owner');
   const keptRoom=JSON.parse((await jsonRequest(s.port,'GET',`/api/rooms/${room.id}`,{token})).body);expect(keptRoom.memberIds).toEqual([other]);
   expect(readdirSync(join(root,'backups')).filter(n=>n.startsWith(`fired-${id}-`))).toEqual([]);expect(db.get('SELECT 1 FROM storage_meta WHERE key=?','member-deletion/'+id)).toBeUndefined();expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  }finally{await new Promise<void>(r=>s.server.close(()=>r()));}
 });
});
