import {getDatabase,type Database} from '../data/database.js';
import {storageScopeId} from './conversations.js';
// The authenticated platform user is the same stable principal as user read cursors.
const USER='user';
const listeners=new Set<()=>void>();
export function onChatPreferencesChanged(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
export function chatPinnedAt(scope:string,db:Database=getDatabase()):number|null {return db.get<{pinned_at:number}>('SELECT pinned_at FROM chat_pins WHERE scope_id=? AND actor_key=?',storageScopeId(scope),USER)?.pinned_at??null;}
export function setChatPinned(scope:string,pinned:boolean):number|null {
 if(typeof pinned!=='boolean')throw Error('pinned must be a boolean');
 return getDatabase().transaction(db=>{const current=chatPinnedAt(scope,db);if((current!==null)===pinned)return current;
  const id=storageScopeId(scope);if(pinned){const last=db.get<{at:number|null}>('SELECT MAX(pinned_at) AS at FROM chat_pins WHERE actor_key=?',USER)?.at??0;db.run('INSERT INTO chat_pins VALUES(?,?,?)',id,USER,Math.max(Date.now(),last+1));}else db.run('DELETE FROM chat_pins WHERE scope_id=? AND actor_key=?',id,USER);
  db.afterCommit(()=>{for(const listener of listeners)try{listener();}catch{}});return chatPinnedAt(scope,db);
 });
}
