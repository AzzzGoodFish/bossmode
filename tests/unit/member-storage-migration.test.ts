import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
let root: string;
const script=resolve('scripts/migrate-member-storage-v1.mjs');
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'bm-storage-cutover-'));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
function seed(id='mem_a',name='old',body='---\nname: stale\ntitle: Engineer\n---\n\n# 自由正文\n\n'){
 const dir=join(root,'members',id);mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'member.json'),JSON.stringify({id,name,agentTemplate:'general',global:{model:'p/m',credentialId:'ref',skills:[],mcpServers:[]},createdAt:1,updatedAt:2}));
 writeFileSync(join(dir,'member.md'),body);return dir;
}
function run(action: string, phase?: string){
 const env={...process.env,BOSSMODE_DIR:root};delete env.BOSSMODE_MEMBER_STORAGE_TEST_FAIL_AT;
 if(phase)env.BOSSMODE_MEMBER_STORAGE_TEST_FAIL_AT=phase;
 const r=spawnSync(process.execPath,[script,action,'--bossmode-dir',root],{env,encoding:'utf8',timeout:20000});
 if(r.error)throw r.error;return r;
}
function member(){const db=new DatabaseSync(join(root,'bossmode.db'),{readOnly:true});try{return db.prepare('SELECT * FROM members').all();}finally{db.close();}}
describe('offline member storage conversion',()=>{
 it('never writes a rejected output path, including dry-run database destination',()=>{
  seed();const output=join(root,'bossmode.db');
  const r=spawnSync(process.execPath,[script,'--dry-run','--bossmode-dir',root,'--output',output],{env:{...process.env,BOSSMODE_DIR:root},encoding:'utf8'});
  expect(r.status).toBe(2);expect(existsSync(output)).toBe(false);expect(existsSync(join(root,'migrations'))).toBe(false);
 });
 it('takes a consistent backup of an existing database before schema changes',()=>{
  seed();const db=new DatabaseSync(join(root,'bossmode.db'));db.exec("CREATE TABLE original (value TEXT); INSERT INTO original VALUES ('keep')");db.close();
  const r=run('--apply');expect(r.status,r.stdout+r.stderr).toBe(0);
  const backup=new DatabaseSync(join(root,'migrations/member-storage-v1-backup/database-before.sqlite'),{readOnly:true});
  expect(backup.prepare('SELECT value FROM original').get()?.value).toBe('keep');
  expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='members'").get()).toBeUndefined();backup.close();
 });
 it('refuses simultaneous migration while another process owns the SQLite lock',()=>{
  seed();mkdirSync(join(root,'migrations'));const lock=new DatabaseSync(join(root,'migrations/member-storage-v1.lock.sqlite'));
  lock.exec('BEGIN EXCLUSIVE; CREATE TABLE lock (id INTEGER)');
  try {const r=run('--apply');expect(r.status,r.stdout+r.stderr).toBe(2);expect(r.stdout).toContain('Cannot acquire migration lock');expect(existsSync(join(root,'bossmode.db'))).toBe(false);}
  finally{lock.exec('ROLLBACK');lock.close();}
  expect(run('--apply').status).toBe(0);
 });
 it('dry-run preserves all files and does not create DB; apply preserves body and name authority, retires sources',()=>{
  const dir=seed();const before=readFileSync(join(dir,'member.md'));const dry=run('--dry-run');expect(dry.status,dry.stdout+dry.stderr).toBe(0);
  expect(dry.stdout).toContain('profile-name-differs');expect(readFileSync(join(dir,'member.md'))).toEqual(before);expect(existsSync(join(root,'bossmode.db'))).toBe(false);expect(existsSync(join(root,'migrations'))).toBe(false);
  const applied=run('--apply');expect(applied.status,applied.stdout+applied.stderr).toBe(0);
  expect(member()[0]).toMatchObject({id:'mem_a',name:'old',name_key:'old',title:'Engineer',created_at:1,updated_at:2});
  expect(readFileSync(join(dir,'persona.md'),'utf8')).toBe('\n# 自由正文\n\n');expect(existsSync(join(dir,'member.json'))).toBe(false);expect(existsSync(join(dir,'member.md'))).toBe(false);
  expect(readFileSync(join(root,'migrations/member-storage-v1-backup/mem_a/member.md'))).toEqual(before);
  writeFileSync(join(dir,'persona.md'),'---\nthis is literal Markdown\n');
  const db=new DatabaseSync(join(root,'bossmode.db'));db.prepare('UPDATE members SET name=?,name_key=? WHERE id=?').run('new','new','mem_a');db.close();
  expect(run('--apply').status).toBe(0);expect(member()[0].name).toBe('new');expect(readFileSync(join(dir,'persona.md'),'utf8')).toContain('literal Markdown');
 });
 it.each(['after-journal','after-first-persona','before-db-commit','during-db-transaction','after-db-commit','after-first-retire'])('recovers safely after %s',phase=>{
  seed();const interrupted=run('--apply',phase);expect(interrupted.status,interrupted.stdout+interrupted.stderr).toBe(86);
  expect(run('--apply').status).toBe(2);const recovered=run('--recover');expect(recovered.status,recovered.stdout+recovered.stderr).toBe(0);expect(member()).toHaveLength(1);expect(run('--recover').status).toBe(0);
 });
 it('refuses changed target during recovery and keeps old sources',()=>{
  const dir=seed();expect(run('--apply','after-first-persona').status).toBe(86);writeFileSync(join(dir,'persona.md'),'user changed this');
  expect(run('--recover').status).toBe(2);expect(readFileSync(join(dir,'persona.md'),'utf8')).toBe('user changed this');expect(existsSync(join(dir,'member.json'))).toBe(true);
 });
 it('rejects case-insensitive duplicate names before any mutation',()=>{
  seed('mem_a','Änne');seed('mem_b','änne');expect(run('--apply').status).toBe(2);expect(existsSync(join(root,'bossmode.db'))).toBe(false);expect(existsSync(join(root,'migrations'))).toBe(false);
 });
 it.each(['---\nname: [\n---\nbody','---\ntitle: 123\n---\nbody','---\nname: old\nbody'])('rejects malformed/ambiguous old profile %s',body=>{
  seed('mem_a','old',body);expect(run('--apply').status).toBe(2);expect(existsSync(join(root,'bossmode.db'))).toBe(false);
 });
 it('refuses conflicting destinations and a running service',()=>{
  const dir=seed();writeFileSync(join(dir,'persona.md'),'different');expect(run('--apply').status).toBe(2);rmSync(join(dir,'persona.md'));
  writeFileSync(join(root,'bossmode.pid'),String(process.pid));expect(run('--apply').status).toBe(2);expect(run('--dry-run').status).toBe(0);
 });
 it('preserves UTF-8 BOM-free raw Markdown and rejects missing DB after completion',()=>{
  const dir=seed('mem_a','raw','\ufeff---\r\nname: raw\r\n---\r\n\r\n原文 😀\r\n');expect(run('--apply').status).toBe(0);
  expect(readFileSync(join(dir,'persona.md'),'utf8')).toBe('\r\n原文 😀\r\n');
  rmSync(join(root,'bossmode.db'));expect(run('--apply').status).toBe(2);
 });
});
