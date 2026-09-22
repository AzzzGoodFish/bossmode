import { useSyncExternalStore } from 'react';
import type { RoomMessage } from '../api/client';
import type { UploadResult } from '../api/upload-client';
export interface PendingFile {id:string;file:File;url:string;status:'pending'|'uploading'|'ready'|'error'|'cancelled';progress:number;uploaded?:UploadResult;error?:string;controller?:AbortController}
export interface Draft {text:string;files:PendingFile[];quote?:RoomMessage;error?:string;busy:boolean;posting?:boolean;revision:number}
let generation=0;const scopeGenerations=new Map<string,number>();
export function getDraftGeneration(scope=''){return `${generation}:${scopeGenerations.get(scope)??0}`;}
export function discardScopeDraft(scope:string){scopeGenerations.set(scope,(scopeGenerations.get(scope)??0)+1);for(const file of store.get(scope)?.files??[]){file.controller?.abort();URL.revokeObjectURL(file.url);}store.delete(scope);listeners.forEach(f=>f());}
const store=new Map<string,Draft>(), listeners=new Set<()=>void>();
export function getDraft(scope:string):Draft {if(!store.has(scope))store.set(scope,{text:'',files:[],busy:false,revision:0});return store.get(scope)!;}
export function updateDraft(scope:string,patch:Partial<Draft>) {const old=getDraft(scope);store.set(scope,{...old,...patch,revision:old.revision+1});listeners.forEach(f=>f());}
export function useDraft(scope:string) {return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>getDraft(scope));}
export function patchFile(scope:string,id:string,patch:Partial<PendingFile>) {const draft=getDraft(scope);updateDraft(scope,{files:draft.files.map(f=>f.id===id?{...f,...patch}:f)});}
export function hasDrafts() {return [...store.values()].some(d=>d.text.trim()||d.files.length||d.quote||d.busy);}
export function clearDrafts() {generation++;for(const d of store.values())for(const f of d.files){f.controller?.abort();URL.revokeObjectURL(f.url);}store.clear();listeners.forEach(f=>f());}
export function moveNewDraft(scope:string) {const from=getDraft('new'),to=getDraft(scope);updateDraft(scope,{text:[to.text,from.text].filter(Boolean).join('\n'),files:[...to.files,...from.files],quote:from.quote??to.quote});store.delete('new');}
export function pauseUploads() {for(const [scope,d] of store){if(!d.busy)continue;for(const f of d.files)f.controller?.abort();updateDraft(scope,{busy:false,error:'连接已中断，文字和附件已保留。请确认发送结果后再重试。',files:d.files.map(f=>f.status==='uploading'?{...f,status:'cancelled'}:f)});}}
