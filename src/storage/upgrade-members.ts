import {readFileSync} from "node:fs";
import {MembersRepository} from "./repositories/members.js";
import {ConversationsRepository} from "./repositories/conversations.js";
import {parseLegacyMemberPersona,parseLegacyMemberRecord} from "./upgrade-member-parser.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import {assertLegacyMemberDirectories} from "./startup-member-verification.js";
import type {LegacySourceEntry} from "./legacy-inventory.js";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import type {MemberRecord} from "../workspace/member-registry.js";

export interface MemberSourceImport {
 consumed:Set<string>;
 /** Converted bodies for the document-metadata importer; current rc.1 bodies remain snapshot inputs. */
 personas:Array<{memberId:string;path:string;body:Uint8Array;updatedAt:number}>;
 /** Retired-looking files in DB-authoritative input must remain inert, not be re-imported. */
 ignoredLegacyPaths:string[];
}
/** Startup chooses source generation from the previous database, not row count or file presence.
 * In particular an empty converted registry does not authorize importing old member.json files. */
export function importLegacyMembers(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],authority:"files"|"database"):MemberSourceImport{
 ctx.db.assertOutsideTransaction();
 const consumed=new Set<string>();const personas:MemberSourceImport["personas"]=[];
 const legacyEntries=entries.filter(e=>e.kind==="member-metadata"||e.kind==="member-profile-mixed");
 const read=(path:string)=>{
  if(!ctx.sourceFiles.includes(path))throw new Error(`Missing snapshotted member source: ${path}`);
  const file=managedPath(ctx.sourceRoot,path);requireRegularFile(file);return readFileSync(file);
 };
 const members=new MembersRepository(ctx.db);const conversations=new ConversationsRepository(ctx.db);
 if(authority==="database"){
  for(const record of members.list()){
   const path=`members/${record.id}/persona.md`;
   const bytes=read(path);
   try{new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error(`Invalid current persona UTF-8: ${record.id}`);}
   conversations.ensureDmScope(record.id);
  }
  for(const e of legacyEntries)consumed.add(e.path);
  return {consumed,personas,ignoredLegacyPaths:legacyEntries.map(e=>e.path)};
 }
 const prepared:Array<{record:MemberRecord;path:string;body:Uint8Array}>=[];
 for(const entry of legacyEntries.filter(e=>e.kind==="member-metadata")){
  if(!entry.memberId)throw new Error("Legacy member metadata has no ID");
  const record=parseLegacyMemberRecord(read(entry.path),entry.memberId,entry.path);
  const profilePath=`members/${record.id}/member.md`;
  const profile=entries.find(e=>e.path===profilePath&&e.kind==="member-profile-mixed");
  const converted:ReturnType<typeof parseLegacyMemberPersona>=profile?parseLegacyMemberPersona(read(profilePath),profilePath):{body:Buffer.alloc(0)};
  if(converted.title!==undefined)record.title=converted.title;
  const unmigrated=`members/${record.id}/memory/persona.md`;
  if(ctx.sourceFiles.includes(unmigrated)){
   const legacyBody=read(unmigrated);
   try{new TextDecoder("utf-8",{fatal:true}).decode(legacyBody);}catch{throw new Error(`Invalid legacy persona UTF-8: ${record.id}`);}
   // Before member.md existed, memory/persona.md was the current persona, not
   // an unresolved merge. Copy its exact bytes only when that newer profile is
   // absent. An existing profile, including an explicitly empty one, must not
   // silently resurrect an older body. The document importer retains history.
   if(!profile)converted.body=legacyBody;
   else if(legacyBody.toString("utf8").trim())throw new Error(`Unmerged legacy persona: ${record.id}`);
  }
  prepared.push({record,path:`members/${record.id}/persona.md`,body:converted.body});
  consumed.add(entry.path);if(profile)consumed.add(profilePath);
 }
 for(const entry of legacyEntries)if(!consumed.has(entry.path))throw new Error(`Legacy profile has no identity metadata: ${entry.path}`);
 assertLegacyMemberDirectories(ctx.root,new Set(prepared.map(item=>item.record.id)));
 for(const item of prepared){
  if(ctx.sourceFiles.includes(item.path)){
   // An earlier attempt may have published this generated persona before DB cutover.
   // Reuse only this importer's ID-owned retained body, byte-identical to conversion
   // of the verified snapshot's selected persona source. Never relax stageAsset's
   // application-storage/source protection. The runner rechecks all live source
   // hashes before cutover; the document importer still verifies body ownership.
   const source=entries.find(e=>e.path===item.path);
   if(!source||source.kind!=="document-body"||source.format!=="text"||source.retire||source.scopeId!==undefined
    ||source.memberId!==item.record.id||source.layer!=="persona"||source.layout!=="member"||source.documentPath!==item.path
    ||!read(item.path).equals(Buffer.from(item.body))){
    throw new Error(`Existing asset differs or has unverified member ownership: ${item.path}`);
   }
  }else ctx.stageAsset(item.path,item.body);
 }
 ctx.db.transaction(tx=>{
  const registry=new MembersRepository(tx);const scopes=new ConversationsRepository(tx);
  for(const {record}of prepared){registry.insert(record);scopes.ensureDmScope(record.id);}
 });
 for(const {record,path,body}of prepared)personas.push({memberId:record.id,path,body,updatedAt:record.updatedAt});
 return {consumed,personas,ignoredLegacyPaths:[]};
}
