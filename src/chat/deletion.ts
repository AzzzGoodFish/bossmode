import type {Database} from '../data/database.js';
import {parseMmScopeId} from './conversations.js';
export function privateScopesForMember(memberId:string,db:Database):string[] {
  return db.all<{id:string;kind:string;member_id:string|null}>("SELECT id,kind,member_id FROM scopes WHERE kind IN ('dm','mm')").filter(scope=>scope.kind==='dm'?scope.member_id===memberId:parseMmScopeId(scope.id)?.includes(memberId)).map(scope=>scope.id);
}
/** Chat-owned rows only. Application removes document scope links before this call. */
export function purgeConversationRows(scopeId:string,db:Database):void {
  for(const table of ['reply_settlements','reply_obligation_dispositions','reply_obligations','chat_admissions','captured_deliveries','delivery_captures','message_archive_entries','message_archives','messages','dm_member_cursor_sequences','outbox','read_cursors','scope_sequences'])db.run(`DELETE FROM ${table} WHERE scope_id=?`,scopeId);
  db.run('DELETE FROM outbox WHERE scope_id=?',`room:${scopeId}`);
  db.run('DELETE FROM scopes WHERE id=?',scopeId);
}
/** Do not remove the member's published messages or attachments in surviving groups. */
export function purgeMemberChatReceipts(memberId:string,db:Database):void {
  db.run('DELETE FROM chat_admissions WHERE target_actor_key=?',memberId);
  db.run('DELETE FROM captured_deliveries WHERE target_member_id=? OR target_actor_key=?',memberId,memberId);
  db.run('DELETE FROM reply_obligations WHERE member_id=? OR actor_key=?',memberId,memberId);
  db.run('DELETE FROM reply_obligation_dispositions WHERE actor_key=?',memberId);
  db.run('DELETE FROM reply_settlements WHERE actor_key=?',memberId);
  db.run("DELETE FROM read_cursors WHERE kind='member' AND actor_key=?",memberId);
  db.run('DELETE FROM room_member_snapshots WHERE id=? OR migrated_id=? OR source_member_id=?',memberId,memberId,memberId);
}
