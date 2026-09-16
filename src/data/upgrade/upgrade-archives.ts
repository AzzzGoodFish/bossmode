import {readFileSync} from "node:fs";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import type {LegacySourceEntry} from "./legacy-inventory.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import {parseLegacyMemberPersona,parseLegacyMemberRecord} from "./upgrade-member-parser.js";
import {catalogFromFiredExport,catalogFromLegacyManifest} from "../../member/member-archive.js";
import {MemberArchivesRepository} from "../repositories/member-archives.js";
import {MembersRepository} from "../repositories/members.js";

function archiveTime(path:string):number|undefined{
 const match=path.match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/);
 if(!match)return;
 const value=Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
 return Number.isFinite(value)?value:undefined;
}
/** Archive manifests are imported once. Immutable export contents remain backups,
 * not another live source consulted by archive listing/import or member lookup. */
export function importLegacyArchives(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[]):Set<string>{
 ctx.db.assertOutsideTransaction();const sources=entries.filter(e=>e.kind==="export-snapshot");const consumed=new Set<string>();
 const paths=new Set(sources.map(e=>e.path));
 const read=(path:string)=>{
  if(!paths.has(path)||!ctx.sourceFiles.includes(path))throw new Error(`Unsnapshotted archive source: ${path}`);
  const file=managedPath(ctx.sourceRoot,path);requireRegularFile(file);return readFileSync(file);
 };
 const text=(path:string)=>{try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(read(path));}catch{throw new Error(`Invalid archive text: ${path}`);}};
 const object=(path:string):Record<string,any>=>{
  let value:any;try{value=JSON.parse(text(path));}catch{throw new Error(`Invalid archive metadata: ${path}`);}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid archive metadata: ${path}`);return value;
 };
 const catalog=new MemberArchivesRepository(ctx.db);const members=new MembersRepository(ctx.db);
 for(const archivePath of new Set(sources.map(e=>e.archivePath!))){
  if(!archivePath)throw new Error("Missing export archive identity");
  if(archivePath.startsWith("backups/fired-")){
   const metadataPath=`${archivePath}/member.json`;
   if(paths.has(metadataPath)){
    const raw=object(metadataPath);if(typeof raw.name!=="string"||!raw.name)throw new Error("Invalid fired member name");
    const personaPath=[`${archivePath}/persona.md`,`${archivePath}/member.md`,`${archivePath}/memory/persona.md`].find(p=>paths.has(p));
    const format=personaPath?.endsWith("/member.md")?"frontmatter":"plain";
    const parsed:ReturnType<typeof parseLegacyMemberPersona>|undefined=personaPath?(format==="frontmatter"?parseLegacyMemberPersona(read(personaPath),personaPath):{body:Buffer.from(text(personaPath))}):undefined;
    const source=catalogFromFiredExport({archivePath,member:{name:raw.name,agentTemplate:raw.agentTemplate||"general",global:raw.global??{},title:raw.title??parsed?.title},
     persona:personaPath?{path:personaPath,format,hasContent:!!(parsed&&Buffer.from(parsed.body).toString("utf8").trim())}:undefined});
    const at=archiveTime(archivePath);
    // A complete stable-ID export can retain a deleted identity. It cannot steal
    // a still-live ID, or associate a name-only export with a current name.
    if(typeof raw.id==="string"&&at!==undefined&&raw.createdAt!==undefined&&raw.updatedAt!==undefined&&raw.agentTemplate!==undefined&&raw.global!==undefined){
     const record=parseLegacyMemberRecord(read(metadataPath),raw.id,metadataPath);
     if(!members.getRetained(record.id))members.importArchived(record,archivePath,at);
     if(!members.get(record.id)){
      if(members.archivedPath(record.id)!==archivePath)throw new Error("Conflicting archived identity locations");
      source.memberId=record.id;
     }
    }
    catalog.importCatalog(source);
   }
  }else{
   const manifestPath=`${archivePath}/manifest.json`;
   if(paths.has(manifestPath)){
    const manifest=object(manifestPath);
    if(manifest.members!==undefined&&!Array.isArray(manifest.members))throw new Error("Invalid legacy archive members");
    const records=(manifest.members??[]).map((member:any)=>{
     if(!member||typeof member.name!=="string"||!member.name)throw new Error("Invalid legacy archive member");
     let personaPath:string|undefined;
     if(typeof member.principlesPath==="string"){
      const candidate=member.principlesPath.startsWith(`${archivePath}/`)?member.principlesPath
       :member.principlesPath.includes("/rooms/")?`${archivePath}/rooms/${member.principlesPath.split("/rooms/").at(-1)}`:undefined;
      if(candidate&&paths.has(candidate))personaPath=candidate;
     }
     return {...member,personaPath,hasPersona:personaPath?!!text(personaPath).trim():false};
    });
    for(const source of catalogFromLegacyManifest({archivePath,members:records}))catalog.importCatalog(source);
   }
  }
 }
 for(const e of sources){if(!ctx.sourceFiles.includes(e.path))throw new Error("Incomplete export snapshot");consumed.add(e.path);}
 return consumed;
}
