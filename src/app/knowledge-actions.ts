import {existsSync,statSync} from "node:fs";
import * as knowledge from "../knowledge/documents.js";
import {updateRuleDocPaths,updateRuleDocPathsByPrefix} from "../chat/conversations.js";

export type PathMutation=
  | {ok:true;type:"file"|"folder";from:string;to?:string}
  | {ok:false;error:string};

function inspect(path:string):{path:string;type:"file"|"folder"}|null{
  try{
    const canonical=knowledge._internal.normalizeDocPath(path),absolute=knowledge._internal.absDocPath(canonical);
    if(!existsSync(absolute))return null;
    return {path:canonical,type:statSync(absolute).isDirectory()?"folder":"file"};
  }catch{return null;}
}

function targetPath(from:string,to:string):string{
  const target=inspect(to);
  return target?.type==="folder"?`${target.path}/${from.split("/").pop()}`:knowledge._internal.normalizeDocPath(to);
}

export function moveKnowledgePath(from:string,to:string):PathMutation{
  const source=inspect(from);if(!source)return {ok:false,error:"Source not found"};
  let target:string;try{target=targetPath(source.path,to);}catch(error){return {ok:false,error:String((error as Error).message||error)};}
  if(source.type==="file"){
    const moved=knowledge.moveEntry(source.path,target);if(!moved)return {ok:false,error:"Source not found or destination conflicts"};
    updateRuleDocPaths(source.path,moved.id);return {ok:true,type:"file",from:source.path,to:moved.id};
  }
  const moved=knowledge.moveFolder(source.path,target);if(!moved.ok)return {ok:false,error:moved.error||"Folder move failed"};
  updateRuleDocPathsByPrefix(source.path,target);return {ok:true,type:"folder",from:source.path,to:target};
}

export function deleteKnowledgePath(path:string):PathMutation{
  const source=inspect(path);if(!source)return {ok:false,error:"Document not found"};
  if(source.type==="file"){
    if(!knowledge.deleteEntry(source.path))return {ok:false,error:"Document not found"};
    updateRuleDocPaths(source.path);return {ok:true,type:"file",from:source.path};
  }
  const deleted=knowledge.deleteFolder(source.path);if(!deleted.ok)return {ok:false,error:"Folder not found"};
  for(const deletedPath of deleted.deletedPaths)updateRuleDocPaths(deletedPath);
  return {ok:true,type:"folder",from:source.path};
}
