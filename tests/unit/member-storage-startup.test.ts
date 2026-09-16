import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";
import { getDefaultConfig } from "../../src/config/config.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import { migratedMemberId } from "../helpers/short-id.js";
import type { Database } from "../../src/data/database.js";

let root: string;
let db: Database | undefined;
const member = {id:"mem_old",name:"old",agentTemplate:"general",global:{model:"p/m"},createdAt:1,updatedAt:2};
beforeEach(() => { root = process.env.BOSSMODE_DIR!; mkdirSync(join(root,"knowledge"),{recursive:true}); });
afterEach(() => { db?.close(); db = undefined; rmSync(root,{recursive:true,force:true}); });
function file(path: string, value: string) { const full = join(root,path); mkdirSync(dirname(full),{recursive:true}); writeFileSync(full,value); }
async function start() { const result = await prepareCoreStorage({root,initialConfig:getDefaultConfig(),bundledCatalog:[]}); db = result.db; return result; }
function oldDatabase(marked = true, withTable = true) {
  const old = new DatabaseSync(join(root,"bossmode.db"));
  old.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY)");
  if (marked) old.exec("INSERT INTO schema_migrations VALUES('member-storage-v1')");
  if (withTable) old.exec("CREATE TABLE members(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,title TEXT,agent_template TEXT NOT NULL,global_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return old;
}

describe("ordinary startup member authority", () => {
  it("initializes and reopens fresh SQL authority without a manual command", async () => {
    const first = await start(); expect(first.migrated).toBe(true);
    expect(new MembersRepository(db!).list()).toEqual([]); db!.close();
    expect((await start()).migrated).toBe(false);
  });
  it("imports legacy IDs, metadata and body at normal startup, then ignores poisoned leftovers", async () => {
    file("members/mem_old/member.json",JSON.stringify(member));
    file("members/mem_old/member.md","---\nname: wrong-label\ntitle: Engineer\n---\n\n literal body \n");
    const first = await start();
    const mid=migratedMemberId(db!,"mem_old");
    expect(new MembersRepository(db!).get(mid)).toMatchObject({...member,id:mid,title:"Engineer"});
    expect(readFileSync(join(root,`members/${mid}/persona.md`),"utf8")).toBe("\n literal body \n");
    expect(db!.get("SELECT member_id FROM memory_documents WHERE path=?",`members/${mid}/persona.md`)).toEqual({member_id:mid});
    expect(readFileSync(join(first.backupDirectory!,"files/members/mem_old/member.json"),"utf8")).toBe(JSON.stringify(member));
    expect(existsSync(join(root,`members/${mid}/member.json`))).toBe(false);
    db!.close(); file(`members/${mid}/member.json`,"poison");
    expect((await start()).migrated).toBe(false);
    expect(new MembersRepository(db!).get(mid)?.name).toBe("old");
  });
  it("retains an empty prior SQL registry as authority, ignoring invalid retired identities", async () => {
    oldDatabase().close();
    file("members/mem_old/member.json","invalid retired JSON"); file("members/mem_old/member.md","---\nbroken");
    await start(); expect(new MembersRepository(db!).list()).toEqual([]);
    expect(db!.all("SELECT * FROM memory_documents")).toEqual([]);
  });
  it.each([[false,true],[true,false]])("rejects inconsistent old authority marker=%s table=%s", async (marked, table) => {
    oldDatabase(marked,table).close();
    await expect(start()).rejects.toThrow("Unrecognized previous member authority");
    const prior = new DatabaseSync(join(root,"bossmode.db"),{readOnly:true});
    try { expect(prior.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_meta'").get()).toBeUndefined(); } finally { prior.close(); }
  });
  it("refuses missing current persona instead of restoring it from retired profile text", async () => {
    const old = oldDatabase();
    old.prepare("INSERT INTO members VALUES (?,?,?,?,?,?,?,?)").run(member.id,member.name,member.name,null,"general","{}",1,2); old.close();
    file("members/mem_old/member.md","stale replacement");
    await expect(start()).rejects.toThrow("Missing snapshotted member source");
    expect(readFileSync(join(root,"members/mem_old/member.md"),"utf8")).toBe("stale replacement");
  });
  it("rejects orphan mixed profiles and permits corrected ordinary retry", async () => {
    file("members/mem_old/member.md","body");
    await expect(start()).rejects.toThrow("no identity metadata");
    expect(existsSync(join(root,"bossmode.db"))).toBe(false);
    file("members/mem_old/member.json",JSON.stringify(member));
    await start(); const mid=migratedMemberId(db!,"mem_old");
    expect(new MembersRepository(db!).get(mid)?.name).toBe(member.name);
  });
  it.each(["not sqlite", ""]) ("propagates unreadable or unrecognized existing authority %j", async bytes => {
    file("bossmode.db",bytes);
    if (bytes) await expect(start()).rejects.toThrow();
    else { // An empty file has no member authority; ordinary startup may initialize it.
      await start(); expect(new MembersRepository(db!).list()).toEqual([]);
    }
  });
});
