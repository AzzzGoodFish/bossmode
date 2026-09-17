import { getDefaultConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";

import { getMember, listMembers } from "../../src/member/identity.js";
import { migratedMemberId } from "../helpers/short-id.js";
import type { Database } from "../../src/data/database.js";

const fault = vi.hoisted(() => ({ phase: "" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return {...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    const [source, target] = args.map(String);
    if (fault.phase === "before-cutover" && source.endsWith("upgrades/staging.sqlite")) throw new Error("injected before cutover");
    if (fault.phase === "retirement" && target.endsWith(".retired")) throw new Error("injected retirement");
    return actual.renameSync(...args);
  }};
});
let root: string;
let db: Database | undefined;
beforeEach(() => { fault.phase=""; root=process.env.BOSSMODE_DIR!; mkdirSync(join(root,"knowledge"),{recursive:true}); });
afterEach(() => { db?.close(); db=undefined; rmSync(root,{recursive:true,force:true}); });
function file(path: string, bytes: string) { const target=join(root,path); mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,bytes); }
function seed(id="mem_a",name="old",body="---\nname: stale\ntitle: Engineer\n---\n\n# 自由正文\n\n") {
  const record={id,name,agentTemplate:"general",global:{model:"p/m",credentialId:"ref",skills:[],mcpServers:[]},createdAt:1,updatedAt:2};
  file(`members/${id}/member.json`,JSON.stringify(record)); file(`members/${id}/member.md`,body); return record;
}
async function start(activate?: (db:Database)=>Promise<void>) {
  const result=await prepareCoreStorage({root,initialConfig:getDefaultConfig(),bundledCatalog:[],activate}); db=result.db; return result;
}

describe("automatic member storage conversion and recovery", () => {
  it("backs up the previous database consistently without changing its original tables", async () => {
    seed(); const old=new DatabaseSync(join(root,"bossmode.db")); old.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('keep')"); old.close();
    const result=await start(); const backup=new DatabaseSync(join(result.backupDirectory!,"database-before.sqlite"),{readOnly:true});
    try { expect(backup.prepare("SELECT value FROM original").get()).toEqual({value:"keep"}); expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='members'").get()).toBeUndefined(); }
    finally { backup.close(); }
    expect(db!.get("SELECT value FROM original")).toEqual({value:"keep"});
  });
  it("retains metadata authority, exact UTF-8/BOM/CRLF body bytes, source backup and idempotence", async () => {
    const body="\ufeff---\r\nname: stale\r\ntitle: Engineer\r\n---\r\n\r\n原文 😀\r\n";
    const member=seed("mem_a","old",body); const result=await start();
    const mid=migratedMemberId(db!,"mem_a");
    expect(getMember(mid, db!)).toMatchObject({...member,id:mid,title:"Engineer"});
    expect(readFileSync(join(root,`members/${mid}/persona.md`),"utf8")).toBe("\r\n原文 😀\r\n");
    expect(readFileSync(join(result.backupDirectory!,"files/members/mem_a/member.md"),"utf8")).toBe(body);
    expect(existsSync(join(root,`members/${mid}/member.md`))).toBe(false);
    db!.run("UPDATE members SET name='new',name_key='new' WHERE id=?",mid); db!.close();
    file(`members/${mid}/persona.md`,"---\nthis is literal Markdown\n");
    await start(); expect(getMember(mid, db!)?.name).toBe("new");
    expect(readFileSync(join(root,`members/${mid}/persona.md`),"utf8")).toBe("---\nthis is literal Markdown\n");
  });
  it("holds an exclusive startup lease through activation and allows later ordinary reopen", async () => {
    seed(); await start(async () => { await expect(start()).rejects.toThrow(/lease/); });
    db!.close(); expect((await start()).migrated).toBe(false);
  });
  it("rejects an existing SQLite writer without changing prior authority or legacy files", async () => {
    seed(); const lock=new DatabaseSync(join(root,"bossmode.db")); lock.exec("CREATE TABLE original(value TEXT); BEGIN IMMEDIATE");
    try { await expect(start()).rejects.toThrow(/locked|busy/); expect(existsSync(join(root,"members/mem_a/member.json"))).toBe(true); }
    finally { lock.exec("ROLLBACK"); lock.close(); }
    await start(); expect(listMembers(db!)).toHaveLength(1);
  }, 10000);
  it("ordinary startup recovers after application activation fails without reimporting identities", async () => {
    seed(); await expect(start(async () => { throw new Error("activation failed"); })).rejects.toThrow("activation failed");
    const result=await start(); expect(result.migrated).toBe(false);
    expect(listMembers(db!)).toHaveLength(1);
    expect(existsSync(join(root,"members/mem_a/member.json"))).toBe(false);
  });
  it("retirement failures retain files and committed authority, then retry without duplication", async () => {
    seed(); fault.phase="retirement"; const first=await start();
    const mid=migratedMemberId(db!,"mem_a");
    // Retirement ran before the id migration in this same start, so the warning carries the seed path.
    expect(first.warnings).toContain("Legacy source retirement pending: members/mem_a/member.json");
    expect(listMembers(db!)).toHaveLength(1); expect(existsSync(join(root,`members/${mid}/member.json`))).toBe(true);
    db!.close(); fault.phase=""; const retry=await start();
    expect(retry.warnings).toEqual([]); expect(retry.migrated).toBe(false); expect(listMembers(db!)).toHaveLength(1);
    expect(existsSync(join(root,`members/${mid}/member.json`))).toBe(false);
  });
  it("keeps user edits made after cutover rather than retiring or reimporting them", async () => {
    seed(); fault.phase="retirement"; await start(); const mid=migratedMemberId(db!,"mem_a"); db!.close(); fault.phase="";
    file(`members/${mid}/member.json`,"user edited retired source");
    const retry=await start(); expect(retry.warnings).toContain(`Legacy source retirement pending: members/${mid}/member.json`);
    expect(readFileSync(join(root,`members/${mid}/member.json`),"utf8")).toBe("user edited retired source");
    expect(getMember(mid, db!)?.name).toBe("old");
  });
  it("rejects normalized duplicate names before activating any identities", async () => {
    seed("mem_a","Änne"); seed("mem_b","änne"); await expect(start()).rejects.toThrow(/already taken/);
    expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(existsSync(join(root,"members/mem_a/member.json"))).toBe(true);
    expect(existsSync(join(root,"members/mem_a/persona.md"))).toBe(false);
    seed("mem_b","different");
    await start(); expect(listMembers(db!)).toHaveLength(2);
  });
  it.each(["---\nname: [\n---\nbody","---\ntitle: 123\n---\nbody","---\nname: old\nbody"])("rejects malformed historical frontmatter %j with retry", async body => {
    seed("mem_a","old",body); await expect(start()).rejects.toThrow(/legacy member/);
    expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(readFileSync(join(root,"members/mem_a/member.md"),"utf8")).toBe(body);
    seed(); await start(); expect(listMembers(db!)).toHaveLength(1);
  });
  it("never overwrites a conflicting persona destination or retires the original sources", async () => {
    seed(); file("members/mem_a/persona.md","user changed this");
    await expect(start()).rejects.toThrow(/Generated asset|Existing asset/);
    expect(readFileSync(join(root,"members/mem_a/persona.md"),"utf8")).toBe("user changed this");
    expect(existsSync(join(root,"members/mem_a/member.json"))).toBe(true); expect(existsSync(join(root,"bossmode.db"))).toBe(false);
  });
  it("refuses another live service before any database or backup creation", async () => {
    seed(); file("bossmode.pid",String(process.ppid)); await expect(start()).rejects.toThrow("Another Bossmode process");
    expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(existsSync(join(root,"backups"))).toBe(false);
  });
  it("retries normal startup after persona publication but before database cutover", async () => {
    seed(); fault.phase="before-cutover"; await expect(start()).rejects.toThrow("injected before cutover");
    expect(existsSync(join(root,"bossmode.db"))).toBe(false); expect(existsSync(join(root,"members/mem_a/member.json"))).toBe(true);
    expect(readFileSync(join(root,"members/mem_a/persona.md"),"utf8")).toBe("\n# 自由正文\n\n");
    fault.phase=""; await start(); expect(listMembers(db!)).toHaveLength(1);
    expect(readdirSync(join(root,"upgrades")).some(name=>name.startsWith("interrupted-"))).toBe(true);
  });
});
