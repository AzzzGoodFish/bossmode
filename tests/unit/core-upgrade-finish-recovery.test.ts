import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCoreStorage } from "../../src/storage/core-startup.js";
import { prepareStorageUpgrade } from "../../src/storage/upgrade-runner.js";
import { discoverLegacyInventory } from "../../src/storage/legacy-inventory.js";
import { importLegacyMembers } from "../../src/storage/upgrade-members.js";
import { coreStorageMigrations, CORE_STORAGE_FORMAT } from "../../src/storage/migrations.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import type { Database } from "../../src/storage/database.js";

const fault = vi.hoisted(() => ({ cutover: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fault.cutover && String(args[0]).endsWith("upgrades/staging.sqlite") && String(args[1]).endsWith("/bossmode.db")) throw new Error("injected pre-cutover failure");
    return actual.renameSync(...args);
  }};
});
let root: string;
let db: Database | undefined;
const persona = "members/mem_one/persona.md";
const metadata = "members/mem_one/member.json";
const profile = "members/mem_one/member.md";
const body = "\r\n literal 😀\r\n";
function file(path: string, bytes: string) { mkdirSync(dirname(join(root,path)),{recursive:true}); writeFileSync(join(root,path),bytes); }
function seed() {
  file(metadata,JSON.stringify({id:"mem_one",name:"not-a-path",agentTemplate:"general",global:{},createdAt:1,updatedAt:2}));
  file(profile,"\ufeff---\r\nname: ignored\r\n---\r\n"+body);
}
async function start(onProgress?: Parameters<typeof prepareCoreStorage>[0]["onProgress"]) {
  const result = await prepareCoreStorage({root,initialConfig:getDefaultConfig(),bundledCatalog:[],onProgress}); db=result.db; return result;
}
beforeEach(() => { root=process.env.BOSSMODE_DIR!; mkdirSync(join(root,"knowledge"),{recursive:true}); fault.cutover=false; });
afterEach(() => { db?.close(); db=undefined; fault.cutover=false; rmSync(root,{recursive:true,force:true}); });

it("retries repeated pre-cutover failures over a previous DB, retaining every backup and the published inode", async () => {
  seed(); const prior=new DatabaseSync(join(root,"bossmode.db")); prior.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('keep')"); prior.close();
  fault.cutover=true;
  await expect(start()).rejects.toThrow("injected pre-cutover failure");
  const inode=statSync(join(root,persona)).ino;
  const firstBackup=readdirSync(join(root,"backups"))[0];
  const originalMetadata=readFileSync(join(root,metadata));
  await expect(start()).rejects.toThrow("injected pre-cutover failure");
  expect(statSync(join(root,persona)).ino).toBe(inode);
  fault.cutover=false;
  const result=await start();
  expect(result.migrated).toBe(true); expect(result.warnings).toEqual([]);
  expect(db!.all("SELECT id,name FROM members")).toEqual([{id:"mem_one",name:"not-a-path"}]);
  expect(db!.get("SELECT value FROM original")).toEqual({value:"keep"});
  expect(readFileSync(join(root,persona),"utf8")).toBe(body); expect(statSync(join(root,persona)).ino).toBe(inode);
  expect(readFileSync(join(root,"backups",firstBackup,"files",metadata))).toEqual(originalMetadata);
  expect(readFileSync(join(root,"backups",firstBackup,"assets",persona),"utf8")).toBe(body);
  expect(readdirSync(join(root,"backups"))).toHaveLength(3);
  expect(readdirSync(join(root,"upgrades")).filter(p=>p.startsWith("interrupted-"))).toHaveLength(2);
  expect(db!.get("SELECT member_id FROM memory_documents WHERE path=?",persona)).toEqual({member_id:"mem_one"});
  expect(existsSync(join(root,metadata))).toBe(false);
});

it.each(["edited body", "\ufeff"+body, body.replaceAll("\r\n","\n")])("preserves changed published bytes after failure, refusing retry: %j", async edited => {
  seed(); fault.cutover=true; await expect(start()).rejects.toThrow("injected pre-cutover failure");
  const original=readFileSync(join(root,metadata));
  file(persona,edited); fault.cutover=false;
  await expect(start()).rejects.toThrow("Existing asset differs");
  expect(readFileSync(join(root,persona),"utf8")).toBe(edited);
  expect(readFileSync(join(root,metadata))).toEqual(original);
  expect(existsSync(join(root,profile))).toBe(true); expect(existsSync(join(root,"bossmode.db"))).toBe(false);
  expect(readdirSync(join(root,"upgrades")).some(p=>p.startsWith("interrupted-"))).toBe(true);
});

it("retains an identical preexisting persona only by parsed ID ownership and exact snapshot bytes", async () => {
  seed(); file(persona,body); const inode=statSync(join(root,persona)).ino;
  await start();
  expect(statSync(join(root,persona)).ino).toBe(inode);
  expect(db!.get("SELECT id FROM members")).toEqual({id:"mem_one"});
});

it("rechecks the live retained body after snapshot reuse and preserves a concurrent edit", async () => {
  seed(); file(persona,body);
  await expect(start(progress => { if(progress.phase==="validating")file(persona,"changed after snapshot"); })).rejects.toThrow("Source changed before cutover");
  expect(readFileSync(join(root,persona),"utf8")).toBe("changed after snapshot");
  expect(existsSync(join(root,metadata))).toBe(true); expect(existsSync(join(root,"bossmode.db"))).toBe(false);
});

it.each(["memberId","layout","retire","scopeId"]) ("rejects reused body with invalid importer ownership: %s", async field => {
  seed(); file(persona,body);
  const entries=discoverLegacyInventory(root).entries;
  const entry=entries.find(e=>e.path===persona)!;
  Object.assign(entry,{[field]:field==="retire"?true:"wrong"});
  await expect(prepareStorageUpgrade({root,formatVersion:CORE_STORAGE_FORMAT,migrations:coreStorageMigrations,
    collectLegacySources:async()=>entries,
    importData:async ctx=>{importLegacyMembers(ctx,entries,"files");},validate:async()=>{},
  })).rejects.toThrow("unverified member ownership");
  expect(readFileSync(join(root,persona),"utf8")).toBe(body); expect(existsSync(join(root,"bossmode.db"))).toBe(false);
});

it.each([persona,metadata])("keeps stageAsset's source/application-storage rejection even for identical bytes: %s", async path => {
  seed(); file(persona,body); const original=readFileSync(join(root,path));
  await expect(prepareStorageUpgrade({root,formatVersion:CORE_STORAGE_FORMAT,migrations:coreStorageMigrations,
    collectLegacySources:async()=>discoverLegacyInventory(root).entries,
    importData:async ctx=>{ctx.stageAsset(path,original);},validate:async()=>{},
  })).rejects.toThrow("Generated asset must be a retained Markdown body, not application storage");
  expect(readFileSync(join(root,path))).toEqual(original); expect(existsSync(join(root,"bossmode.db"))).toBe(false);
});
