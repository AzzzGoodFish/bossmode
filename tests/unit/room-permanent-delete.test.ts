import {it,expect,vi} from 'vitest';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTestServer,getTestBossmodeDir,jsonRequest,setupTestWorkspace} from '../helpers/test-server.js';
import {getDatabase} from '../../src/data/database.js';
import {createMember} from '../../src/app/member-actions.js';
import {createRoom,getRoom} from '../../src/chat/conversations.js';
import {appendMessageInTransaction} from '../../src/chat/messages.js';
import {getMember} from '../../src/member/identity.js';
import {quiesceConversation} from '../../src/agent/controls.js';
import {instances,type AgentInstance} from '../../src/agent/instance.js';
setupTestWorkspace();
it('deletes a populated room but retains its members, private chats, tokens and other rooms',async()=>{
 const server=await createTestServer();try{
 const token=JSON.parse((await jsonRequest(server.port,'POST','/api/auth/login',{body:{username:'testuser',password:'testpass'}})).body).token;
 const member=createMember({name:'Group-only delete member'}),room=createRoom('Delete this group',[member.id]),kept=createRoom('Keep this group',[member.id]),db=getDatabase(),root=getTestBossmodeDir();
 for(const scope of [`room:${room.id}`,`room:${kept.id}`,`dm:${member.id}`])db.transaction(tx=>appendMessageInTransaction(tx,scope,{sender:'user',content:'real persisted history',mentions:[]}));
 writeFileSync(join(root,'rooms',room.id,'owned.txt'),'room file');writeFileSync(join(root,'members',member.id,'keep.txt'),'member file');
 db.run('INSERT INTO token_usage_daily VALUES(?,?,?,?,?,?,?,?,?)',member.id,'2026-09-22','fixture',1,2,3,4,0,1);
 const res=await jsonRequest(server.port,'DELETE',`/api/rooms/${room.id}`,{token});expect(res.status,res.body).toBe(200);
 expect(getRoom(room.id)).toBeNull();expect(getRoom(kept.id)).not.toBeNull();expect(getMember(member.id)).not.toBeNull();
 expect(existsSync(join(root,'rooms',room.id))).toBe(false);expect(existsSync(join(root,'members',member.id,'keep.txt'))).toBe(true);
 expect(db.get('SELECT 1 FROM messages WHERE scope_id=?',room.id)).toBeUndefined();expect(db.get('SELECT 1 FROM messages WHERE scope_id=?',kept.id)).toBeDefined();expect(db.get('SELECT 1 FROM messages WHERE scope_id=?',`dm:${member.id}`)).toBeDefined();expect(db.get('SELECT 1 FROM token_usage_daily WHERE member_id=?',member.id)).toBeDefined();expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
 }finally{await new Promise<void>(r=>server.server.close(()=>r()));}
});
it('interrupts only the deleted source, never destroys member instances or interrupts another chat',async()=>{
 const target=createMember({name:'target turn'}),other=createMember({name:'other turn'});const first={memberId:target.id,agentName:target.name,activeSourceRef:'room:rm_deleted',promptInFlight:true,turnActive:true,dispatchState:'running',handle:{abort:vi.fn(),waitForIdle:vi.fn(async()=>{}),destroy:vi.fn()}} as unknown as AgentInstance;
 const second={memberId:other.id,agentName:other.name,activeSourceRef:'dm:'+other.id,promptInFlight:true,turnActive:true,dispatchState:'running',handle:{abort:vi.fn(),waitForIdle:vi.fn(async()=>{}),destroy:vi.fn()}} as unknown as AgentInstance;
 instances.set(target.id,first);instances.set(other.id,second);try{await quiesceConversation('room:rm_deleted');expect(first.handle.abort).toHaveBeenCalledOnce();expect(first.handle.waitForIdle).toHaveBeenCalledOnce();expect(first.handle.destroy).not.toHaveBeenCalled();expect(second.handle.abort).not.toHaveBeenCalled();expect(instances.has(target.id)).toBe(true);}finally{instances.delete(target.id);instances.delete(other.id);}
});
