import {extname,resolve} from "node:path";
import {getRoom,roomMemberAssetRoots} from "../chat/conversations.js";
import {locateReadableFile,readFileBytes} from "../files/io.js";
import {documentsRoot} from "../files/layout.js";
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
  const root=documentsRoot(),candidates=[resolve(root,input.normalized),...input.roots.map(value=>resolve(value,originalPath))];
  if(originalPath.startsWith("/"))candidates.push(originalPath);
  const located=locateReadableFile(candidates,[root,...input.roots],MAX_PREVIEW_BYTES);
  if(!located.ok)return {ok:false,error:located.code==="not_found"?`Artifact not found: ${originalPath}`:located.error,status:located.code==="not_found"?404:400};
  return {ok:true,path:located.path,size:located.size,type:input.type,normalized:input.normalized};
}
export function readArtifactPreview(roomId:string,originalPath:string):ArtifactPreview{
  const input=validated(roomId,originalPath);if("ok" in input)return input;
  if(input.type!=="image"){
    const entry=getEntry(input.normalized);
    if(entry)return {ok:true,type:input.type,originalPath,path:entry.id,title:entry.title,content:entry.content};
  }
  const artifact=resolveArtifact(roomId,originalPath);if(!artifact.ok)return artifact;
  const bytes=readFileBytes(artifact.path);
  return {ok:true,type:artifact.type,originalPath,path:artifact.normalized,
    title:artifact.normalized.split(/[\\/]/).pop()||artifact.normalized,
    content:artifact.type==="image"?bytes:bytes.toString("utf8")};
}
