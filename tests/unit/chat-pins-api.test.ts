import {it,expect} from 'vitest';
import {setupTestWorkspace,createTestServer,jsonRequest} from '../helpers/test-server.js';
import {createMember,deleteMemberCompletely} from '../../src/app/member-actions.js';
import {createRoom} from '../../src/chat/conversations.js';
import {deleteRoomCompletely} from '../../src/app/chat-deletion-actions.js';
import {getDatabase} from '../../src/data/database.js';
setupTestWorkspace();
it('persists user pins, returns sorted chats, supports unpin and removes preferences with deleted instances',async()=>{
 const server=await createTestServer();try{
 const token=JSON.parse((await jsonRequest(server.port,'POST','/api/auth/login',{body:{username:'testuser',password:'testpass'}})).body).token;
 const member=createMember({name:'Pin test member'}),room=createRoom('Pin test room',[member.id]),dm=`dm:${member.id}`,group=`room:${room.id}`;
 const endpoint=(s:string)=>`/api/conversations/${encodeURIComponent(s)}/pin`;
 expect((await jsonRequest(server.port,'PUT',endpoint(dm),{body:{pinned:true}})).status).toBe(401);
 for(const body of [{pinned:'true'},{pinned:true,other:1},null])expect((await jsonRequest(server.port,'PUT',endpoint(dm),{token,body})).status).toBe(400);
 let r=await jsonRequest(server.port,'PUT',endpoint(dm),{token,body:{pinned:true}});expect(r.status,r.body).toBe(200);const first=JSON.parse(r.body).pinnedAt;
 r=await jsonRequest(server.port,'PUT',endpoint(dm),{token,body:{pinned:true}});expect(JSON.parse(r.body).pinnedAt).toBe(first);
 await jsonRequest(server.port,'PUT',endpoint(group),{token,body:{pinned:true}});
 let chats=JSON.parse((await jsonRequest(server.port,'GET','/api/chats',{token})).body).chats;expect(chats[0].scopeId).toBe(group);expect(chats[1].scopeId).toBe(dm);expect(chats[1].pinnedAt).toBe(first);
 const db=getDatabase();expect(db.get('SELECT pinned_at FROM chat_pins WHERE scope_id=?',dm)).toEqual({pinned_at:first});
 await jsonRequest(server.port,'PUT',endpoint(group),{token,body:{pinned:false}});chats=JSON.parse((await jsonRequest(server.port,'GET','/api/chats',{token})).body).chats;expect(chats[0].scopeId).toBe(dm);expect(chats.find((c:{scopeId:string})=>c.scopeId===group).pinnedAt).toBeUndefined();
 await jsonRequest(server.port,'PUT',endpoint(group),{token,body:{pinned:true}});await deleteRoomCompletely(room.id);expect(db.get('SELECT 1 FROM chat_pins WHERE scope_id=?',room.id)).toBeUndefined();await deleteMemberCompletely(member.id,{confirm:true});expect(db.get('SELECT 1 FROM chat_pins WHERE scope_id=?',dm)).toBeUndefined();expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
 }finally{await new Promise<void>(r=>server.server.close(()=>r()));}
});
