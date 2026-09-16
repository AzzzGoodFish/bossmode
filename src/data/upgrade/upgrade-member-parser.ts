// Pure source conversion for the normal-startup upgrade. No file or DB access.
import { parseDocument } from "yaml";
import type { MemberRecord } from "../../member/member-registry.js";

function text(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", {fatal:true}).decode(bytes); }
  catch { throw new Error(`Invalid UTF-8 in legacy member source: ${path}`); }
}

/** Same byte boundary as the accepted member-storage-v1 conversion; never trims body. */
export function parseLegacyMemberPersona(bytes: Uint8Array, path: string): {body: Uint8Array; title?: string; profileName?: string} {
  const decoded=text(bytes,path);
  const prefix=decoded.match(/^(?:\uFEFF)?---\r?\n/);
  if (!prefix) return {body:bytes};
  const remaining=decoded.slice(prefix[0].length);
  const close=/^(?:---|\.\.\.)\r?(?:\n|$)/m.exec(remaining);
  if (!close) throw new Error(`Unterminated legacy member frontmatter: ${path}`);
  let meta: any;
  try {
    const document=parseDocument(remaining.slice(0,close.index),{uniqueKeys:true});
    if (document.errors.length) throw new Error("invalid YAML");
    meta=document.contents===null?{}:document.toJS({maxAliasCount:100});
  } catch { throw new Error(`Invalid legacy member frontmatter: ${path}`); }
  if (!meta || typeof meta!=="object" || Array.isArray(meta) || (meta.title!==undefined && typeof meta.title!=="string") || (meta.name!==undefined && typeof meta.name!=="string")) throw new Error(`Invalid legacy member profile metadata: ${path}`);
  const consumed=prefix[0]+remaining.slice(0,close.index+close[0].length);
  const bom=bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf && !decoded.startsWith("\uFEFF") ? 3 : 0;
  return {body:bytes.subarray(Buffer.byteLength(consumed,"utf8")+bom),...(meta.title?.trim()?{title:meta.title.trim()}:{}),...(meta.name!==undefined?{profileName:meta.name}:{})};
}

/** Legacy member.json owns identity; a differing profile header never renames it. */
export function parseLegacyMemberRecord(bytes: Uint8Array, memberId: string, path: string): MemberRecord {
  let value: any;
  try { value=JSON.parse(text(bytes,path)); }
  catch { throw new Error(`Invalid legacy member record: ${path}`); }
  if (!value || value.id!==memberId || !/^mem_[a-zA-Z0-9_-]+$/.test(memberId) ||
    typeof value.name!=="string" || !value.name.trim() || value.name.trim().length>64 || /[/\0]/.test(value.name) ||
    typeof value.agentTemplate!=="string" || !value.agentTemplate || !value.global || typeof value.global!=="object" || Array.isArray(value.global) ||
    !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) throw new Error(`Invalid legacy member record: ${path}`);
  const {extensions:_retired,...global}=value.global;
  return {id:memberId,name:value.name.trim(),agentTemplate:value.agentTemplate,global,createdAt:value.createdAt,updatedAt:value.updatedAt,
    unifiedModel:true,unifiedExtensions:true,scopeOverrides:{}};
}
