import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { membersMigration } from "../../src/storage/schema/members.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import type { MemberRecord } from "../../src/workspace/member-registry.js";
let root: string, db: Database;
const record = (id = "mem_original", name = "言实") : MemberRecord => ({id,name,title:" engineer ",agentTemplate:"general",unifiedModel:true,unifiedExtensions:true,global:{model:null,credentialId:"profile",skills:[],mcpServers:[]},scopeOverrides:{},createdAt:0,updatedAt:1});
beforeEach(() => { root=mkdtempSync(join(tmpdir(),"bm-core-members-")); db=openDatabase(join(root,"bossmode.db")); });
afterEach(() => {db.close();rmSync(root,{recursive:true,force:true});});
describe("core member identity repository", () => {
  it("preserves accepted rc.1 identity/config rows while enforcing the new constraints", () => {
    db.exec("CREATE TABLE members(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,title TEXT,agent_template TEXT NOT NULL,global_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    new MembersRepository(db).insert(record());
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    expect(new MembersRepository(db).get("mem_original")).toEqual(record());
    expect(db.get("SELECT credential_id,model FROM members")).toEqual({credential_id:"profile",model:null});
    expect(()=>db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(NULL,'bad','bad','general','{}',0,0)")).toThrow(/NOT NULL/);
  });
  it("keeps archived identities for FK history but frees the label for a new active member", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    db.exec("CREATE TABLE historical_execution(member_id TEXT NOT NULL REFERENCES members(id), result TEXT)");
    const repo=new MembersRepository(db); repo.insert(record());
    db.run("INSERT INTO historical_execution VALUES('mem_original','retained result')");
    repo.archive("mem_original","backups/fired-original",2);
    expect(repo.get("mem_original")).toBeNull(); expect(repo.list()).toEqual([]);
    repo.insert(record("mem_replacement"));
    expect(repo.findByNameKey("言实")?.id).toBe("mem_replacement");
    expect(repo.archivedPath("mem_original")).toBe("backups/fired-original");
    expect(db.all("SELECT * FROM historical_execution")).toEqual([{member_id:"mem_original",result:"retained result"}]);
    expect(()=>repo.delete("mem_original")).toThrow(/FOREIGN KEY/);
  });
  it("rolls back an archival transition with its surrounding service transaction", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    const repo=new MembersRepository(db);repo.insert(record());
    expect(()=>db.transaction(tx=>{new MembersRepository(tx).archive("mem_original","backups/fired-original",2);throw new Error("service failure");})).toThrow("service failure");
    expect(repo.get("mem_original")).toEqual(record());expect(repo.archivedPath("mem_original")).toBeNull();
  });
  it("retains normalized name uniqueness and refuses malformed config JSON", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    const repo=new MembersRepository(db);repo.insert(record("mem_one","Alice"));
    expect(()=>repo.insert(record("mem_two","alice"))).toThrow(/UNIQUE/);
    expect(()=>db.run("UPDATE members SET global_json='[]'")).toThrow(/CHECK/);
    expect(repo.get("mem_one")?.global.credentialId).toBe("profile");
  });
});
