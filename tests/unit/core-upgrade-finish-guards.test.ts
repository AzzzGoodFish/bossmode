import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";
import { inspectStartupSettings } from "../../src/app/upgrade/inventory.js";
import { getDefaultConfig } from "../../src/config/config.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import type { Database } from "../../src/data/database.js";
import { MemberArchiveService } from "../../src/member/archive/member-archive-lifecycle.js";
import { migratedMemberId } from "../helpers/short-id.js";

let root: string;
let db: Database | undefined;
const journal="migrations/member-storage-v1.json";
const member={id:"mem_one",name:"same-label",agentTemplate:"general",global:{},createdAt:1,updatedAt:2};
// Short-id migration (batch 5) re-keys members on first startup: post-start code must
// target the current id and paths; the legacy seed above stays literal.
let mid="mem_one";
let persona="members/mem_one/persona.md";
function syncIds() { mid=migratedMemberId(db!,"mem_one"); persona=`members/${mid}/persona.md`; }
function file(path: string, bytes: string) { mkdirSync(dirname(join(root,path)),{recursive:true}); writeFileSync(join(root,path),bytes); }
function seed() { file("members/mem_one/member.json",JSON.stringify(member)); file("members/mem_one/member.md","original body"); }
async function start(activate?: (db: Database)=>Promise<void>) {
  const result=await prepareCoreStorage({root,initialConfig:getDefaultConfig(),bundledCatalog:[],activate}); db=result.db; return result;
}
beforeEach(() => { root=process.env.BOSSMODE_DIR!; mkdirSync(join(root,"knowledge"),{recursive:true}); });
afterEach(() => { db?.close(); db=undefined; rmSync(root,{recursive:true,force:true}); });

it.each(["{invalid",'{"status":"prepared"}','{"status":"done"}']) ("blocks setup inspection and repeated startup with a missing DB journal, even with intact legacy sources: %s", async bytes => {
  seed(); file(journal,bytes);
  expect(()=>inspectStartupSettings(root)).toThrow("authoritative database is missing");
  for(let attempt=0;attempt<2;attempt++)await expect(start()).rejects.toThrow("authoritative database is missing");
  expect(readFileSync(join(root,journal),"utf8")).toBe(bytes);
  expect(readFileSync(join(root,"members/mem_one/member.json"),"utf8")).toBe(JSON.stringify(member));
  expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(existsSync(join(root,persona))).toBe(false);
});

it("does not reinterpret a historical journal when a verified current DB exists", async () => {
  seed(); await start(); db!.close(); file(journal,"{old broken journal");
  expect(inspectStartupSettings(root).source).toBe("database");
  expect((await start()).migrated).toBe(false);
  expect(new MembersRepository(db!).list()).toHaveLength(1);
  expect(readFileSync(join(root,journal),"utf8")).toBe("{old broken journal");
});

it.each([false,true])("rejects unknown-only member assets without resolving their directory through a display name (previous empty DB=%s)", async previous => {
  seed();
  if(previous)new DatabaseSync(join(root,"bossmode.db")).close();
  file("members/same-label/skills/private/custom.txt","unknown bytes");
  await expect(start()).rejects.toThrow("no identity metadata: members/same-label");
  expect(readFileSync(join(root,"members/same-label/skills/private/custom.txt"),"utf8")).toBe("unknown bytes");
  expect(existsSync(join(root,persona))).toBe(false);
  expect(existsSync(join(root,"members/mem_one/member.json"))).toBe(true);
  if(previous){
    const prior=new DatabaseSync(join(root,"bossmode.db"),{readOnly:true});
    try { expect(prior.prepare("SELECT name FROM sqlite_master WHERE name='members'").get()).toBeUndefined(); }finally{prior.close();}
  }else expect(existsSync(join(root,"bossmode.db"))).toBe(false);
});

it("does not infer identity from a metadata ID that disagrees with its asset directory", async () => {
  file("members/mem_other/member.json",JSON.stringify(member)); file("members/mem_other/persona.md","");
  await expect(start()).rejects.toThrow();
  expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(existsSync(join(root,"members/mem_other/member.json"))).toBe(true);
});

it.each(["missing-file","missing-directory","directory-body","symlink-body","symlink-directory"]) ("fails current-generation startup visibly before activation without stale-body repair: %s", async damage => {
  seed(); await start(); syncIds(); db!.close();
  if(damage==="missing-directory"||damage==="symlink-directory")rmSync(join(root,`members/${mid}`),{recursive:true});
  else rmSync(join(root,persona));
  if(damage==="directory-body")mkdirSync(join(root,persona));
  if(damage==="symlink-body"){file("retained-body.md","untouched target");symlinkSync(join(root,"retained-body.md"),join(root,persona));}
  if(damage==="symlink-directory"){
    file("retained-directory/persona.md","untouched target");
    symlinkSync(join(root,"retained-directory"),join(root,`members/${mid}`));
  }
  file(`members/${mid}/member.md`,"stale body must stay inert");
  const activate=vi.fn(async()=>{});
  await expect(start(activate)).rejects.toThrow(`Active member persona asset missing or unsafe: ${mid}`);
  expect(activate).not.toHaveBeenCalled();
  expect(readFileSync(join(root,`members/${mid}/member.md`),"utf8")).toBe("stale body must stay inert");
  const authority=new DatabaseSync(join(root,"bossmode.db"),{readOnly:true});
  try { expect(authority.prepare("SELECT id,name FROM members").get()).toEqual({id:mid,name:"same-label"}); }finally{authority.close();}
  if(damage.startsWith("missing"))expect(existsSync(join(root,persona))).toBe(false);
  if(damage==="symlink-body")expect(readFileSync(join(root,"retained-body.md"),"utf8")).toBe("untouched target");
  if(damage==="symlink-directory")expect(readFileSync(join(root,"retained-directory/persona.md"),"utf8")).toBe("untouched target");
});

it("checks current persona ownership even when the body exists", async () => {
  seed(); await start(); syncIds(); db!.run("DELETE FROM memory_documents WHERE path=?",persona); db!.close();
  await expect(start()).rejects.toThrow(`Member persona metadata missing: ${mid}`);
  expect(readFileSync(join(root,persona),"utf8")).toBe("original body");
});

it("does not require a live directory for archived SQL identity or reconstruct one from its reused name", async () => {
  seed(); await start(); syncIds();
  new MembersRepository(db!).archive(mid,"backups/fired-one",3);
  renameSync(join(root,`members/${mid}`),join(root,"backups/fired-one"));
  // Explicit current tombstone fixture: a same-named active identity owns different assets.
  new MembersRepository(db!).insert({...member,id:"mem_two"});
  file("members/mem_two/persona.md","current body");
  db!.run("UPDATE memory_documents SET member_id='mem_two',path='members/mem_two/persona.md' WHERE path=?",persona);
  db!.close();
  expect((await start()).migrated).toBe(false);
  expect(new MembersRepository(db!).list().map(m=>m.id)).toEqual(["mem_two"]);
  expect(new MembersRepository(db!).getRetained(mid)?.name).toBe(member.name);
  expect(existsSync(join(root,`members/${mid}`))).toBe(false);
  expect(readFileSync(join(root,"backups/fired-one/persona.md"),"utf8")).toBe("original body");
  db!.close(); rmSync(join(root,"members/mem_two/persona.md"));
  await expect(start()).rejects.toThrow("Active member persona asset missing or unsafe: mem_two");
});

it.each(["before-move","after-move"]) ("preserves automatic recovery of a pending archive rather than treating it as an active missing directory: %s", async phase => {
  seed(); await start(); syncIds();
  if(phase==="after-move")db!.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON member_archives BEGIN SELECT RAISE(ABORT,'archive failure'); END");
  const archive=new MemberArchiveService(db!,root,{quiesce:async()=>{if(phase==="before-move")throw new Error("quiesce failure");}});
  await expect(archive.archive(mid,{confirm:true})).rejects.toThrow(/failure/);
  expect(archive.admission(mid)).toBe("pending");
  const intent=archive.pending()[0];
  if(phase==="after-move")db!.exec("DROP TRIGGER fail_archive");
  db!.close();
  const result=await start(async ready=>{await new MemberArchiveService(ready,root,{quiesce:async()=>{}}).recoverPending();});
  expect(result.migrated).toBe(false);
  expect(new MembersRepository(db!).get(mid)).toBeNull();
  expect(readFileSync(join(root,intent.archivePath,"persona.md"),"utf8")).toBe("original body");
  expect(existsSync(join(root,`members/${mid}`))).toBe(false);
});

it.each(["both","neither","replaced","symlink","missing-persona"]) ("does not let a pending archive intent bypass asset safety: %s", async conflict => {
  seed(); await start(); syncIds();
  const archive=new MemberArchiveService(db!,root,{quiesce:async()=>{throw new Error("stop");}});
  await expect(archive.archive(mid,{confirm:true})).rejects.toThrow("stop");
  const intent=archive.pending()[0];
  if(conflict==="both")file(`${intent.archivePath}/sentinel`,"unknown bytes");
  if(conflict==="neither"||conflict==="replaced"||conflict==="symlink"){
    renameSync(join(root,intent.sourcePath),join(root,"quarantined-member"));
    if(conflict==="replaced")file(`${intent.sourcePath}/persona.md`,"replacement must not count");
    if(conflict==="symlink")symlinkSync(join(root,"quarantined-member"),join(root,intent.sourcePath));
  }
  if(conflict==="missing-persona")rmSync(join(root,persona));
  db!.close(); const activate=vi.fn(async()=>{});
  await expect(start(activate)).rejects.toThrow(/conflict|symlink|missing or unsafe/);
  expect(activate).not.toHaveBeenCalled();
  if(conflict==="both")expect(readFileSync(join(root,intent.archivePath,"sentinel"),"utf8")).toBe("unknown bytes");
  if(conflict==="replaced")expect(readFileSync(join(root,persona),"utf8")).toBe("replacement must not count");
});

it("leaves pending source retirement untouched when ready asset verification fails", async () => {
  seed(); await start(); syncIds();
  const path=`members/${mid}/member.md`;
  db!.run("UPDATE storage_upgrade_files SET retired_at=NULL WHERE path=?",path);
  file(`members/${mid}/member.md`,"original body");
  const source=db!.get<{backup_path:string}>("SELECT backup_path FROM storage_upgrade_files WHERE path=?",path)!;
  // Model a pending retirement whose destination is still free.
  rmSync(join(root,source.backup_path+".retired")); db!.close(); rmSync(join(root,persona));
  await expect(start()).rejects.toThrow("Active member persona asset missing or unsafe");
  expect(readFileSync(join(root,path),"utf8")).toBe("original body");
  expect(existsSync(join(root,source.backup_path+".retired"))).toBe(false);
  const authority=new DatabaseSync(join(root,"bossmode.db"),{readOnly:true});
  try{expect(authority.prepare("SELECT retired_at FROM storage_upgrade_files WHERE path=?").get(path)).toEqual({retired_at:null});}finally{authority.close();}
});
