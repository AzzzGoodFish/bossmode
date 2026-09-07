#!/usr/bin/env node
/** One-time offline migration. This command never starts the product runtime. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
const a=process.argv.slice(2), value=(n)=>{const i=a.indexOf(n);return i<0?undefined:a[i+1]};
const rootArg=value('--bossmode-dir'), output=value('--output');
if(!a.includes('--dry-run')||!rootArg||!isAbsolute(rootArg)){console.error('Use --dry-run --bossmode-dir <absolute sandbox> [--output report.ndjson]');process.exit(1)}
let root;try{root=await realpath(rootArg)}catch{console.error('bossmode directory does not exist');process.exit(1)}
const lines=[], emit=x=>lines.push(JSON.stringify(x)); let plans=0, conflicts=0, errors=0, skipped=0; const referenced=new Set();
const memberIds=new Set(existsSync(join(root,'members')) ? (await readdir(join(root,'members'),{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name) : []);
emit({kind:'header',format:'member-session-migration-dry-run/v1',mode:'dry-run',writes:false,generatedAt:new Date().toISOString()});
function hash(file){return createHash('sha256').update(readFileSync(file)).digest('hex')}
function reportConflict(source,reason,detail){conflicts++;emit({kind:'conflict',source,reason,detail,status:'manual-required'})}
async function walk(dir){if(!existsSync(dir))return [];const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p)}return out}
// A legacy reference is authoritative only when both its member id and session file are explicit.
for(const file of await walk(join(root,'rooms'))){if(!file.endsWith('/sessions.json'))continue;let refs;try{refs=JSON.parse(readFileSync(file,'utf8'))}catch(e){errors++;emit({kind:'error',source:file,reason:'invalid-reference-json',detail:String(e)});continue} const parts=file.slice(root.length+1).split('/'), roomId=parts[1], topicAt=parts.indexOf('topics'), topicId=topicAt>=0?parts[topicAt+1]:null, scopeId=topicId?`topic:${topicId}`:`room:${roomId}`, targetKind=topicId?`topics/${topicId}`:`rooms/${roomId}`;
 for(const [memberId,session] of Object.entries(refs)){const s=session||{};if(s.sessionFile) referenced.add(resolve(s.sessionFile));if(!memberIds.has(memberId)){reportConflict(file,'unresolved-owner',{scopeId,memberKey:memberId});continue}if(!s.sessionFile||!existsSync(s.sessionFile)){reportConflict(s.sessionFile||file,'missing-session-file',{scopeId,memberId,sessionId:s.sessionId});continue}let header;try{header=JSON.parse(readFileSync(s.sessionFile,'utf8').split('\n')[0])}catch{reportConflict(s.sessionFile,'missing-header-date',{scopeId,memberId});continue}if(!header.timestamp||!header.id){reportConflict(s.sessionFile,'missing-header-date',{scopeId,memberId});continue}const day=String(header.timestamp).slice(0,10), target=`members/${memberId}/sessions/${day}/${targetKind}/${s.sessionFile.split('/').at(-1)}`;const size=statSync(s.sessionFile).size;plans++;emit({kind:'plan',source:s.sessionFile,target,memberId,scopeId,sessionId:s.sessionId||header.id,size,sha256:hash(s.sessionFile),referenceChange:{scopeId,from:{file,memberKey:memberId,session:s},to:{file:`members/${memberId}/sessions/current.json`,memberKey:scopeId,session:s}},status:'ready'});}}
// Do not silently omit raw legacy runtime files that have no trustworthy scope/member reference.
for(const file of await walk(root)){if(!file.endsWith('.jsonl')||file.includes('/members/')||referenced.has(resolve(file)))continue; reportConflict(file,'unresolved-owner',{detail:'no authoritative room/topic/current reference'});}
emit({kind:'summary',planned:plans,conflicts,errors,skippedIdentical:skipped,writes:0,exitCode:errors?1:conflicts?2:0});
const text=lines.join('\n')+'\n';if(output){const {writeFileSync}=await import('node:fs');writeFileSync(output,text)}else process.stdout.write(text);process.exitCode=errors?1:conflicts?2:0;
