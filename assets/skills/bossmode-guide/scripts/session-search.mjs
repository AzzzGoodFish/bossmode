#!/usr/bin/env node
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const args = process.argv.slice(2); const take=(n)=>{const i=args.indexOf(n);return i<0?undefined:args[i+1]};
const flag=(n)=>args.includes(n); const action=args.find(x=>['list','search','expand'].includes(x));
function integer(name, fallback, min, max=100000){const raw=take(name);if(raw===undefined)return fallback;if(!/^\d+$/.test(raw))fail(`${name} must be a finite integer`);const value=Number(raw);if(value<min||value>max)fail(`${name} must be between ${min} and ${max}`);return value}
const rootArg=take('--member-dir'); const limit=integer('--limit',50,1); const maxBytes=integer('--max-bytes',65536,1024,1048576);
function fail(message){ console.error(JSON.stringify({kind:'error',message})); process.exit(1) }
if (!action || !rootArg || !isAbsolute(rootArg)) fail('Use list, search, or expand with an absolute --member-dir.');
let root; try { root=realpathSync(rootArg) } catch { fail('member directory does not exist') }
if (!/[/\\]members[/\\][^/\\]+$/.test(root)) fail('--member-dir must be a members/<memberId> directory');
const relSafe=(file)=>{ const r=relative(root,file); return r && !r.startsWith('..') && !isAbsolute(r) ? r : null };
const emitState={bytes:0, stopped:false};
function emit(value, reserve=0){ const line=JSON.stringify(value); if (emitState.bytes+Buffer.byteLength(line)+1+reserve>maxBytes){ emitState.stopped=true; return false } process.stdout.write(line+'\n'); emitState.bytes+=Buffer.byteLength(line)+1; return true }
function cursor(value){ return Buffer.from(JSON.stringify(value)).toString('base64url') }
function parseCursor(){ const raw=take('--cursor'); if(!raw)return null; try{return JSON.parse(Buffer.from(raw,'base64url').toString())}catch{fail('invalid --cursor')} }
async function* files(dir){ if(!existsSync(dir))return; for(const ent of await readdir(dir,{withFileTypes:true})){ const p=resolve(dir,ent.name); if(ent.isDirectory()) yield* files(p); else if(ent.isFile()&&ent.name.endsWith('.jsonl')) yield p; } }
function scopeFor(file){ const p=relSafe(file)?.split('/'); const i=p?.indexOf('sessions'); if(i===undefined||i<0)return 'background'; const kind=p[i+2]; const id=p[i+3]; const memberId=root.split('/').at(-1); return kind==='rooms'?`room:${id}`:kind==='topics'?`topic:${id}`:kind==='dm'?`dm:${memberId}`: 'unknown'; }
function scrub(entry){ const clone=JSON.parse(JSON.stringify(entry)); const clean=(v)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(clean);return} delete v.thinkingSignature; delete v.encrypted_content; for(const x of Object.values(v))clean(x)}; clean(clone); return clone }
function textOf(e){ const safe=scrub(e); const c=safe?.message?.content; return typeof c==='string'?c:Array.isArray(c)?c.map(x=>typeof x==='string'?x:x?.text||'').join('\n'):JSON.stringify(safe?.message||safe) }
async function scan(file, visit){ let n=0; const rl=createInterface({input:createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity}); for await(const line of rl){n++; if(!line.trim())continue; try{await visit(JSON.parse(line),n)}catch{emit({kind:'diagnostic',file:relSafe(file),line:n,reason:'invalid-jsonl-record'})} } }
const from=take('--from')?Date.parse(take('--from')):-Infinity, to=take('--to')?Date.parse(take('--to')):Infinity, wanted=take('--scope');
if(Number.isNaN(from)||Number.isNaN(to))fail('--from/--to must be UTC ISO timestamps');
if(action==='expand'){
 const requested=take('--file'), id=take('--entry'); if(!requested||!id)fail('expand requires --file and --entry'); const candidate=resolve(root,requested); let file; try{file=await realpath(candidate)}catch{fail('file not found')}; if(!relSafe(file)||!statSync(file).isFile())fail('file escapes member directory');
 const entries=[]; await scan(file,(e,line)=>entries.push({...e,_line:line})); const at=entries.findIndex(e=>e.id===id); if(at<0)fail('entryId not found');
 const byId=new Map(entries.filter(e=>e.id).map(e=>[e.id,e])); const chain=[]; for(let e=entries[at];e; e=e.parentId?byId.get(e.parentId):null)chain.unshift(e); const before=integer('--before',3,0,1000), after=integer('--after',3,0,1000);
 const direct=entries.filter(e=>e.parentId===id).slice(0,after); emit({kind:'expand',file:relSafe(file),entryId:id,branch:true,ancestors:chain.slice(-(before+1)).map(scrub),children:direct.map(scrub)}); process.exit(0);
}
const query=take('--text'); if(action==='search'&&!query)fail('search requires --text'); const start=parseCursor(); let passed=!start, count=0, lastPosition=null;
const scanRoots=[resolve(root,'sessions'), ...(flag('--include-background')?[resolve(root,'background-tasks')]:[])];
for (const scanRoot of scanRoots) for await(const file of files(scanRoot)){  const rel=relSafe(file); if(!flag('--include-background')&&rel?.includes('/background-tasks/'))continue; const scope=scopeFor(file); if(wanted&&scope!==wanted)continue; await scan(file,(e,line)=>{ const position={file:rel,line}; if(!passed){if(position.file===start.file&&position.line===start.line)passed=true;return} if(count>=limit||emitState.stopped)return; const stamp=Date.parse(e.timestamp||e.message?.timestamp||''); if(action==='search'&&(stamp<from||stamp>to||!textOf(e).includes(query)))return; if(action==='list'&&(e.type!=='session'||stamp<from||stamp>to))return; const result={kind:action,file:rel,scope,sessionId:e.type==='session'?e.id:undefined,entryId:e.id,timestamp:e.timestamp||e.message?.timestamp,role:e.message?.role,parentId:e.parentId,toolCallId:e.toolCallId,summary:textOf(e).slice(0,500),branch:!!e.parentId}; if(emit(result,256)){count++; lastPosition=position;} }); if(count>=limit||emitState.stopped)break; }
if(count>=limit||emitState.stopped)emit({kind:'truncated',nextCursor:lastPosition?cursor(lastPosition):null,reason:emitState.stopped?'max-bytes':'limit'});
