import {expect,it} from 'vitest';
import {setupTestWorkspace,createTestServer,jsonRequest} from '../helpers/test-server.js';
import {createMember,deleteMemberCompletely} from '../../src/app/member-actions.js';
import {createRoom,inviteRoomMember,removeRoomMember} from '../../src/chat/conversations.js';
import {appendMessageInTransaction,listMessageSearchAuthors,searchMessages} from '../../src/chat/messages.js';
import {getDatabase} from '../../src/data/database.js';
setupTestWorkspace();
it('separates current, left and deleted stable authors without retaining deleted identities or merging reused names',async()=>{
 const db=getDatabase(),current=createMember({name:'Current author',title:'PRIVATE_TITLE_NOT_IN_AUTHOR_DTO'}),left=createMember({name:'Left author'}),gone=createMember({name:'Reused author'}),silent=createMember({name:'Silent current author'}),outside=createMember({name:'Other-room author'});
 const room=createRoom('Author projection room',[current.id,left.id,gone.id,silent.id]),other=createRoom('Other author room',[outside.id]),scope=`room:${room.id}`;
 const append=(target:string,sender:string,senderMemberId?:string,content='history')=>db.transaction(()=>appendMessageInTransaction(db,target,{sender,senderMemberId,content,mentions:[]}));
 append(scope,'Old display name',current.id);append(scope,left.name,left.id);append(scope,gone.name,gone.id);append(scope,'user');append(`room:${other.id}`,outside.name,outside.id);
 expect(removeRoomMember(room.id,left.id).ok).toBe(true);await deleteMemberCompletely(gone.id,{confirm:true});const reused=createMember({name:'Reused author'});expect(inviteRoomMember(room.id,reused.id).ok).toBe(true);append(scope,'Reused author');
 const before=db.get<{n:number}>('SELECT COUNT(*) n FROM members')!.n,authors=listMessageSearchAuthors(scope);
 expect(authors.find(a=>a.id===current.id)).toMatchObject({name:current.name,status:'current'});expect(authors.find(a=>a.id===silent.id)?.status).toBe('current');expect(authors.find(a=>a.id===left.id)?.status).toBe('left');expect(authors.find(a=>a.id===gone.id)).toMatchObject({name:'Reused author',status:'deleted'});expect(authors.find(a=>a.id===reused.id)?.status).toBe('current');expect(authors.find(a=>a.kind==='legacy')).toMatchObject({name:'Reused author',status:'unknown'});expect(authors.some(a=>a.id===outside.id)).toBe(false);
 expect(JSON.stringify(authors)).not.toContain('PRIVATE_TITLE_NOT_IN_AUTHOR_DTO');expect(db.get('SELECT id FROM members WHERE id=?',gone.id)).toBeUndefined();expect(db.get<{n:number}>('SELECT COUNT(*) n FROM members')!.n).toBe(before);
 const filtered=searchMessages(scope,{query:'absent',limit:1,after:Date.now()+1000,includeAuthors:true});expect(filtered.total).toBe(0);expect(filtered.authors).toEqual(authors);expect(searchMessages(scope,{fromMemberId:gone.id}).total).toBe(1);expect(searchMessages(scope,{from:'Reused author',fromLabelOnly:true}).total).toBe(1);expect(searchMessages(scope).authors).toBeUndefined();expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
});
it('keeps a distant search match inside the bounded response excerpt',()=>{
 const db=getDatabase(),member=createMember({name:'Excerpt author'}),room=createRoom('Long excerpt room',[member.id]),scope=`room:${room.id}`;
 db.transaction(()=>appendMessageInTransaction(db,scope,{sender:'user',content:'before '.repeat(150)+'FIND-THIS-HIT '+'after '.repeat(150),mentions:[]}));const hit=searchMessages(scope,{query:'find-this-hit'}).messages[0];expect(hit.content).toContain('FIND-THIS-HIT');expect(hit.content.startsWith('…')).toBe(true);expect(hit.content.length).toBeLessThanOrEqual(200);
});
it('serves scoped author metadata through the existing authenticated search route',async()=>{
 const server=await createTestServer();try{const token=JSON.parse((await jsonRequest(server.port,'POST','/api/auth/login',{body:{username:'testuser',password:'testpass'}})).body).token,member=createMember({name:'HTTP author'}),room=createRoom('HTTP author room',[member.id]),path=`/api/conversations/${encodeURIComponent('room:'+room.id)}/messages/search?includeAuthors=true&limit=1`;
 expect((await jsonRequest(server.port,'GET',path)).status).toBe(401);const response=await jsonRequest(server.port,'GET',path,{token});expect(response.status,response.body).toBe(200);expect(JSON.parse(response.body).authors).toEqual(expect.arrayContaining([{id:'user',name:'user',kind:'user',status:'current'},{id:member.id,memberId:member.id,name:member.name,kind:'member',status:'current'}]));
 }finally{await new Promise<void>(resolve=>server.server.close(()=>resolve()));}
});
