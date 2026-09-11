import {existsSync} from "node:fs";
import {isDeepStrictEqual} from "node:util";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import {readLegacyJson,type LegacySourceEntry} from "./legacy-inventory.js";
import {SessionRepository} from "./repositories/session-repository.js";
import {RuntimeRepository} from "./repositories/runtime-repository.js";
import {executionScopeId,importExecutionAmbiguity} from "./repositories/execution-identity.js";
import {ensureImportedScope,retiredTopicScope} from "./upgrade-conversations.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import type {AgentSession} from "../shared/types.js";

function object(value:unknown,path:string):Record<string,any>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid legacy execution object: ${path}`);
 return value as Record<string,any>;
}
/** rc.28/current-member generation. Retired room sessions are preserved as historical
 * records, never used to revive an intentionally cleared/absent current association.
 * No SDK history is opened, copied, rewritten or replayed by this adapter. */
export function importLegacyExecution(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[]):Set<string>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();
 const sessions=new SessionRepository(ctx.db);const runtime=new RuntimeRepository(ctx.db);
 const seen=new Map<string,unknown>();
 const unique=(key:string,value:unknown)=>{
  if(!seen.has(key)){seen.set(key,value);return true;}
  if(!isDeepStrictEqual(seen.get(key),value))throw new Error(`Conflicting execution source: ${key}`);
  return false;
 };
 const known=(id:string|undefined):id is string=>!!id&&!!ctx.db.get("SELECT id FROM members WHERE id=?",id);
 const quarantine=(e:LegacySourceEntry,key:string,domain:"session"|"runtime",value:unknown,reason:string)=>{
  importExecutionAmbiguity(ctx.db,{sourcePath:e.path,sourceKey:key,domain,recordJson:JSON.stringify(value),reason,importedAt:Math.trunc(e.mtimeMs)});
 };
 for(const e of entries){
  if(e.kind==="background-task"){consumed.add(e.path);continue;} // background tasks retired (fish #19454); files dropped with the feature
  if(!["current-sessions","old-sessions","runtime-state"].includes(e.kind))continue;
  if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted execution source: ${e.path}`);
  const data=object(readLegacyJson(ctx.sourceRoot,e),e.path);const at=Math.trunc(e.mtimeMs);
  if(e.kind==="current-sessions"){
   for(const [key,value]of Object.entries(data)){
    if(retiredTopicScope(key))continue; // topic scope retired (fish #19358)
    if(!known(e.memberId)){quarantine(e,key,"session",value,"unresolved-current-session-owner");continue;}
    const scope=ensureImportedScope(ctx.db,key);const session=object(value,e.path) as AgentSession;
    if(session.sessionFile!==undefined){
     if(typeof session.sessionFile!=="string")throw new Error("Invalid current session file reference");
     const file=managedPath(ctx.root,`members/${e.memberId}/${session.sessionFile}`);
     if(existsSync(file))requireRegularFile(file);
    }
    if(unique(`session:${e.memberId}:${scope}`,session))sessions.importAssociation({memberId:e.memberId,scopeId:scope,session,referenceKind:"member-relative",createdAt:at,updatedAt:at});
   }
  }else if(e.kind==="old-sessions"){
   for(const [key,value]of Object.entries(data))quarantine(e,key,"session",value,"retired-room-session-generation");
  }else{
   for(const [key,value]of Object.entries(data)){
    const split=key.lastIndexOf(":");const member=key.slice(split+1);const rawScope=key.slice(0,split);
    if(retiredTopicScope(rawScope))continue; // topic scope retired (fish #19358)
    if(split<1||!known(member)||e.memberId!==undefined&&e.memberId!==member){quarantine(e,key,"runtime",value,"unresolved-runtime-owner");continue;}
    let scope:string;try{scope=executionScopeId(rawScope);}catch{quarantine(e,key,"runtime",value,"invalid-runtime-scope");continue;}
    ensureImportedScope(ctx.db,scope);
    const entry=object(value,e.path);
    if(unique(`runtime:${scope}:${member}`,entry))runtime.importEntry(scope,member,entry,at);
   }
  }
  consumed.add(e.path);
 }
 return consumed;
}
