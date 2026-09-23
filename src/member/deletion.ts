import {lstatSync,rmSync} from 'node:fs';
import type {Database} from '../data/database.js';
import {getMember,MemberNotFoundError} from './identity.js';
import {checkedAssetPath,removeOwnedDirectory} from '../files/deletion.js';
const PREFIX='member-deletion/';
const deletedListeners=new Set<(id:string)=>void>();
export function onMemberDeleted(listener:(id:string)=>void):()=>void{deletedListeners.add(listener);return()=>deletedListeners.delete(listener);}
interface Asset {path:string;device:string|null;inode:string|null}
interface Intent {memberId:string;phase:'archive'|'cleanup';assets:Asset[]}
export interface MemberDeletionHooks {
  /** Existing durable close-admission/quiesce/move mechanism; no retained archive after completion. */
  archive(memberId:string):Promise<{archived:string}>;
  privateDirectories(memberId:string,db:Database):string[];
  purgeRecords(memberId:string,db:Database):void;
}
function allowedAsset(path:string,id:string) {return path.startsWith(`backups/fired-${id}-`)||path.startsWith(`member-chats/${id}-mem_`)||path.startsWith('member-chats/mem_')&&path.endsWith(`-${id}`);}
function stat(path:string){try{return lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
function readIntent(db:Database,id:string):Intent|null {
 const row=db.get<{value:string}>('SELECT value FROM storage_meta WHERE key=?',PREFIX+id);if(!row)return null;
 const value=JSON.parse(row.value) as Intent;
 if(value.memberId!==id||!['archive','cleanup'].includes(value.phase)||!Array.isArray(value.assets)||value.assets.some(a=>!allowedAsset(a.path,id)))throw Error('invalid_member_deletion_intent');return value;
}
function save(db:Database,intent:Intent){db.run('INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',PREFIX+intent.memberId,JSON.stringify(intent));}
const flights=new WeakMap<Database,Map<string,Promise<{deleted:string}>>>();
export class MemberDeletionService {
 constructor(private db:Database,private root:string,private hooks:MemberDeletionHooks){}
 delete(memberId:string,options:{confirm?:boolean}):Promise<{deleted:string}> {
  if(!options.confirm)return Promise.reject(Error('confirm_required'));
  if(!/^mem_[a-zA-Z0-9_-]+$/.test(memberId))return Promise.reject(new MemberNotFoundError(memberId));
  let map=flights.get(this.db);if(!map){map=new Map();flights.set(this.db,map);}const existing=map.get(memberId);if(existing)return existing;
  const operation=this.perform(memberId).finally(()=>map!.delete(memberId));map.set(memberId,operation);return operation;
 }
 async recoverPending():Promise<void> {for(const row of this.db.all<{key:string}>('SELECT key FROM storage_meta WHERE key LIKE ?',PREFIX+'%'))await this.delete(row.key.slice(PREFIX.length),{confirm:true});}
 private async perform(id:string):Promise<{deleted:string}> {
  this.db.assertOutsideTransaction();let intent=readIntent(this.db,id);
  if(!intent){if(!getMember(id,this.db))throw new MemberNotFoundError(id);intent={memberId:id,phase:'archive',assets:[]};save(this.db,intent);}
  if(intent.phase==='archive'){
   const result=await this.hooks.archive(id);
   const paths=[result.archived,...this.hooks.privateDirectories(id,this.db)];
   const assets=paths.map(path=>{if(!allowedAsset(path,id))throw Error('invalid_member_deletion_asset');const full=checkedAssetPath(this.root,path),info=stat(full);return {path,device:info?String(info.dev):null,inode:info?String(info.ino):null};});
   this.db.transaction(tx=>{this.hooks.purgeRecords(id,tx);intent={memberId:id,phase:'cleanup',assets};save(tx,intent);});
  }
  // Only captured instance-owned directories. Never enumerate or follow workspace registrations.
  for(const asset of intent.assets)removeOwnedDirectory(this.root,asset.path,asset.device,asset.inode);
  this.db.run('DELETE FROM storage_meta WHERE key=?',PREFIX+id);for(const listener of deletedListeners)try{listener(id);}catch{}return {deleted:id};
 }
}
/** The member domain's metadata, sessions, workspace registrations and SSH credentials. */
export function purgeMemberStoredData(id:string,db:Database):void {
 const prefix=`members/${id}/`;
 db.run('DELETE FROM memory_document_history WHERE document_path IN (SELECT path FROM memory_documents WHERE member_id=? OR substr(path,1,?)=?)',id,prefix.length,prefix);
 db.run('DELETE FROM memory_documents WHERE member_id=? OR substr(path,1,?)=?',id,prefix.length,prefix);
 for(const table of ['member_archive_rooms','member_archive_conflicts'])db.run(`DELETE FROM ${table} WHERE archive_path IN (SELECT archive_path FROM member_archives WHERE member_id=?)`,id);
 for(const table of ['member_archives','member_archive_intents','current_sessions','workspace_registries','ssh_credentials'])db.run(`DELETE FROM ${table} WHERE member_id=?`,id);
 db.run('DELETE FROM members WHERE id=?',id);
}
/** Shared project documents are independent assets, not owned by a deleted chat. */
export function detachDocumentScope(scopeId:string,db:Database):void {
 db.run('UPDATE memory_document_history SET scope_id=NULL WHERE scope_id=?',scopeId);
 db.run('UPDATE memory_documents SET scope_id=NULL WHERE scope_id=?',scopeId);
}
