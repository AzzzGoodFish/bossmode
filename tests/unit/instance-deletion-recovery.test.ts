import {it,expect} from 'vitest';
import {existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {setupTestWorkspace,getTestWorkspace,getTestBossmodeDir} from '../helpers/test-server.js';
import {createMember,deleteMemberCompletely,recoverMemberDeletions} from '../../src/app/member-actions.js';
import {createRoom,getRoom} from '../../src/chat/conversations.js';
import {getMember,getRetainedMember} from '../../src/member/identity.js';
import {RoomDeletionService} from '../../src/chat/room-deletion.js';
import {purgeConversationRows} from '../../src/chat/deletion.js';
import {detachDocumentScope} from '../../src/member/deletion.js';
import {getDatabase} from '../../src/data/database.js';
setupTestWorkspace();
it('retries a SQL failure after member quiescence without leaving a retained archive',async()=>{
 const member=createMember({name:'Recover deletion'}),db=getDatabase();
 db.exec(`CREATE TRIGGER reject_member_delete BEFORE DELETE ON members WHEN OLD.id='${member.id}' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END`);
 await expect(deleteMemberCompletely(member.id,{confirm:true})).rejects.toThrow('injected delete failure');
 expect(getMember(member.id)).toBeNull();expect(getRetainedMember(member.id)).not.toBeNull();expect(db.get('SELECT 1 FROM storage_meta WHERE key=?','member-deletion/'+member.id)).toBeDefined();
 db.exec('DROP TRIGGER reject_member_delete');await recoverMemberDeletions();
 expect(getRetainedMember(member.id)).toBeNull();expect(db.get('SELECT 1 FROM storage_meta WHERE key=?','member-deletion/'+member.id)).toBeUndefined();
 expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
});
it('closes room admission durably and resumes filesystem cleanup without deleting any member',async()=>{
 const member=createMember({name:'Room recovery member'}),room=createRoom('Room recovery',[member.id]),db=getDatabase(),root=getTestBossmodeDir();
 writeFileSync(join(root,'rooms',room.id,'owned.txt'),'room data');let fail=true;
 const service=new RoomDeletionService(db,root,{cancelPending:()=>{},purge:(scope,tx)=>{detachDocumentScope(scope,tx);purgeConversationRows(scope,tx);},quiesce:async()=>{if(fail)throw Error('injected wait failure');}});
 await expect(service.delete(room.id)).rejects.toThrow('injected wait failure');expect(getRoom(room.id)).toBeNull();expect(getMember(member.id)).not.toBeNull();expect(existsSync(join(root,'rooms',room.id))).toBe(true);
 fail=false;await service.recoverPending();expect(existsSync(join(root,'rooms',room.id))).toBe(false);expect(getMember(member.id)).not.toBeNull();expect(existsSync(join(root,'members',member.id))).toBe(true);
 expect(db.get('SELECT 1 FROM storage_meta WHERE key=?','room-deletion/'+room.id)).toBeUndefined();
});
