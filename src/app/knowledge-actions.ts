import {deletePath,movePath,type PathMutation} from "../knowledge/documents.js";
import {updateRuleDocPaths,updateRuleDocPathsByPrefix} from "../chat/conversations.js";

export type {PathMutation};

export function moveKnowledgePath(from:string,to:string):PathMutation{
  const mutation=movePath(from,to);
  if(!mutation.ok)return mutation;
  if(mutation.type==="file")updateRuleDocPaths(mutation.from,mutation.to);
  else updateRuleDocPathsByPrefix(mutation.from,mutation.to!);
  return mutation;
}

export function deleteKnowledgePath(path:string):PathMutation{
  const mutation=deletePath(path);
  if(!mutation.ok)return mutation;
  if(mutation.type==="file")updateRuleDocPaths(mutation.from);
  else updateRuleDocPathsByPrefix(mutation.from);
  return mutation;
}
