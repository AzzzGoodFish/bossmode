import type {Database} from '../data/database.js';
import {checkedAssetPath,statIfPresent,removeOwnedDirectory} from '../files/deletion.js';
import {getRoom} from './conversations.js';
const PREFIX='room-deletion/';
const deletedListeners=new Set<(id:string)=>void>();
export function onRoomDeleted(listener:(id:string)=>void):()=>void{deletedListeners.add(listener);return()=>deletedListeners.delete(listener);}
interface Intent {roomId:string;device:string|null;inode:string|null}
export interface RoomDeletionHooks {
 /** Both hooks run in the same SQL transaction that closes the room. No await/filesystem. */
 cancelPending(sourceRef:string):void;
 purge(scopeId:string,db:Database):void;
 /** Interrupt only this source's in-flight turn; retain members and other-source queues. */
 quiesce(sourceRef:string):Promise<void>;
}
const flights=new WeakMap<Database,Map<string,Promise<boolean>>>();
export class RoomDeletionService {
 constructor(private db:Database,private root:string,private hooks:RoomDeletionHooks){}
 delete(roomId:string):Promise<boolean>{if(!/^[a-zA-Z0-9_-]+$/.test(roomId))return Promise.resolve(false);let map=flights.get(this.db);if(!map){map=new Map();flights.set(this.db,map);}const existing=map.get(roomId);if(existing)return existing;const operation=this.perform(roomId).finally(()=>map!.delete(roomId));map.set(roomId,operation);return operation;}
 async recoverPending():Promise<void>{for(const row of this.db.all<{key:string}>('SELECT key FROM storage_meta WHERE key LIKE ?',PREFIX+'%'))await this.delete(row.key.slice(PREFIX.length));}
 private async perform(roomId:string):Promise<boolean>{
  this.db.assertOutsideTransaction();const saved=this.db.get<{value:string}>('SELECT value FROM storage_meta WHERE key=?',PREFIX+roomId);let intent:Intent;
  if(saved){intent=JSON.parse(saved.value);if(intent.roomId!==roomId||!['string','object'].includes(typeof intent.device)||!['string','object'].includes(typeof intent.inode))throw Error('invalid_room_deletion_intent');}
  else {if(!getRoom(roomId,this.db))return false;const info=statIfPresent(checkedAssetPath(this.root,`rooms/${roomId}`));intent={roomId,device:info?String(info.dev):null,inode:info?String(info.ino):null};
   this.db.transaction(tx=>{this.hooks.cancelPending(`room:${roomId}`);this.hooks.purge(roomId,tx);tx.run('INSERT INTO storage_meta(key,value) VALUES(?,?)',PREFIX+roomId,JSON.stringify(intent));});
  }
  await this.hooks.quiesce(`room:${roomId}`);
  removeOwnedDirectory(this.root,`rooms/${roomId}`,intent.device,intent.inode);
  this.db.run('DELETE FROM storage_meta WHERE key=?',PREFIX+roomId);for(const listener of deletedListeners)try{listener(roomId);}catch{}return true;
 }
}
