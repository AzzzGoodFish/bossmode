import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const membersMigration = getMigration("core-members-v1");
import { insertMemberIdentity, getMember, retireMemberIdentity, listMembers, findMemberByName, memberArchivePath, deleteMemberIdentity } from "../../src/member/identity.js";
import type { MemberRecord } from "../../src/member/identity.js";
let root: string, db: Database;
const record = (id = "mem_original", name = "言实") : MemberRecord => ({id,name,title:" engineer ",agentTemplate:"general",unifiedModel:true,unifiedExtensions:true,global:{model:null,credentialId:"profile",skills:[],mcpServers:[]},scopeOverrides:{},createdAt:0,updatedAt:1});
beforeEach(() => { root=mkdtempSync(join(tmpdir(),"bm-core-members-")); db=openDatabase(join(root,"bossmode.db")); });
afterEach(() => {db.close();rmSync(root,{recursive:true,force:true});});
describe("core member identity repository", () => {
  it("preserves accepted rc.1 identity/config rows while enforcing the new constraints", () => {
    db.exec("CREATE TABLE members(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,title TEXT,agent_template TEXT NOT NULL,global_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    insertMemberIdentity(record(), db);
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    expect(getMember("mem_original", db)).toEqual(record());
    expect(db.get("SELECT credential_id,model FROM members")).toEqual({credential_id:"profile",model:null});
    expect(()=>db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(NULL,'bad','bad','general','{}',0,0)")).toThrow(/NOT NULL/);
  });
  it("keeps archived identities for FK history but frees the label for a new active member", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    db.exec("CREATE TABLE historical_execution(member_id TEXT NOT NULL REFERENCES members(id), result TEXT)");
    const repo=db; insertMemberIdentity(record(), repo);
    db.run("INSERT INTO historical_execution VALUES('mem_original','retained result')");
    retireMemberIdentity("mem_original","backups/fired-original",2, repo);
    expect(getMember("mem_original", repo)).toBeNull(); expect(listMembers(repo)).toEqual([]);
    insertMemberIdentity(record("mem_replacement"), repo);
    expect(findMemberByName("言实", repo)?.id).toBe("mem_replacement");
    expect(memberArchivePath("mem_original", repo)).toBe("backups/fired-original");
    expect(db.all("SELECT * FROM historical_execution")).toEqual([{member_id:"mem_original",result:"retained result"}]);
    expect(()=>deleteMemberIdentity("mem_original", repo)).toThrow(/FOREIGN KEY/);
  });
  it("rolls back an archival transition with its surrounding service transaction", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    const repo=db;insertMemberIdentity(record(), repo);
    expect(()=>db.transaction(tx=>{retireMemberIdentity("mem_original","backups/fired-original",2, tx);throw new Error("service failure");})).toThrow("service failure");
    expect(getMember("mem_original", repo)).toEqual(record());expect(memberArchivePath("mem_original", repo)).toBeNull();
  });
  it("retains normalized name uniqueness and refuses malformed config JSON", () => {
    applyStorageMigrations(db,[baseStorageMigration,membersMigration]);
    const repo=db;insertMemberIdentity(record("mem_one","Alice"), repo);
    expect(()=>insertMemberIdentity(record("mem_two","alice"), repo)).toThrow(/already taken/);
    expect(()=>db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      "mem_two", "alice", "alice", "general", "{}", 1, 2)).toThrow(/UNIQUE/);
    expect(()=>db.run("UPDATE members SET global_json='[]'")).toThrow(/CHECK/);
    expect(getMember("mem_one", repo)?.global.credentialId).toBe("profile");
  });
});
