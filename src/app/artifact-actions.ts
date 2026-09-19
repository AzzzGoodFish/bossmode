import {existsSync,readFileSync,realpathSync} from "node:fs";
import {extname,resolve} from "node:path";
import {getRoom,roomMemberAssetRoots} from "../chat/conversations.js";
import {documentsRoot} from "../files/layout.js";
import {checkPath} from "../kernel/path.js";
import {getEntry} from "../knowledge/documents.js";

const MAX_PREVIEW_BYTES=2*1024*1024;
const TEXT_EXTENSIONS=new Set([
  ".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".sh",".bash",".json",".yaml",".yml",".toml",".xml",".css",".scss",".sql",".go",".rs",".java",".c",".h",".cpp",".cs",".rb",".php",".swift",".kt",".vue",".ini",".conf",".cfg",".env",".properties",".diff",".patch",".csv",".tsv",".log",".proto",".txt",
]);
const TEXT_FILENAMES=new Set(["dockerfile","makefile",".gitignore",".dockerignore"]);
export type ArtifactType="md"|"html"|"image"|"text";
export type ArtifactFailure={ok:false;error:string;status:400|404};
export type ArtifactResolution={ok:true;path:string;type:ArtifactType;size:number;normalized:string}|ArtifactFailure;
export type ArtifactPreview={ok:true;type:ArtifactType;originalPath:string;path:string;title:string;content:string|Buffer}|ArtifactFailure;

function typeOf(path:string):ArtifactType|null{
  const extension=extname(path).toLowerCase();
  if(extension===".md"||extension===".markdown")return "md";
  if(extension===".html"||extension===".htm")return "html";
  if([".png",".jpg",".jpeg",".gif",".webp"].includes(extension))return "image";
  if(TEXT_EXTENSIONS.has(extension)||TEXT_FILENAMES.has((path.split(/[\\/]/).pop()||"").toLowerCase()))return "text";
  return null;
}
function real(path:string):string|null{try{return realpathSync(path);}catch{return null;}}
function validated(roomId:string,originalPath:string):{normalized:string;type:ArtifactType;roots:string[]}|ArtifactFailure{
  if(!getRoom(roomId))return {ok:false,error:"Room not found",status:404};
  if(!originalPath)return {ok:false,error:"path query parameter is required",status:400};
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(originalPath))return {ok:false,error:"Remote URLs are not previewable",status:400};
  const normalized=originalPath.trim().replace(/^docs\//,""),type=typeOf(normalized);
  if(!type)return {ok:false,error:`Unsupported artifact type: ${originalPath}`,status:400};
  return {normalized,type,roots:roomMemberAssetRoots(roomId)};
}
export function resolveArtifact(roomId:string,originalPath:string):ArtifactResolution{
  const input=validated(roomId,originalPath);if("ok" in input)return input;
  const knowledgeRoot=documentsRoot(),allowed=[real(knowledgeRoot),...input.roots.map(real)].filter((path):path is string=>Boolean(path));
  const candidates=[resolve(knowledgeRoot,input.normalized),...input.roots.map(root=>resolve(root,originalPath))];
  if(originalPath.startsWith("/"))candidates.push(originalPath);
  for(const candidate of new Set(candidates)){
    if(!existsSync(candidate))continue;
    const checked=checkPath(candidate,{allowedPrefixes:allowed,maxSizeBytes:MAX_PREVIEW_BYTES});
    if(!checked.ok)return {ok:false,error:checked.error,status:400};
    return {ok:true,path:checked.absolutePath,size:checked.size,type:input.type,normalized:input.normalized};
  }
  return {ok:false,error:`Artifact not found: ${originalPath}`,status:404};
}
export function readArtifactPreview(roomId:string,originalPath:string):ArtifactPreview{
  const input=validated(roomId,originalPath);if("ok" in input)return input;
  if(input.type!=="image"){
    const entry=getEntry(input.normalized);
    if(entry)return {ok:true,type:input.type,originalPath,path:entry.id,title:entry.title,content:entry.content};
  }
  const artifact=resolveArtifact(roomId,originalPath);if(!artifact.ok)return artifact;
  return {ok:true,type:artifact.type,originalPath,path:artifact.normalized,
    title:artifact.normalized.split(/[\\/]/).pop()||artifact.normalized,
    content:artifact.type==="image"?readFileSync(artifact.path):readFileSync(artifact.path,"utf8")};
}
