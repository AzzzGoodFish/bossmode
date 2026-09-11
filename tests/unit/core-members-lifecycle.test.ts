import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyStorageMigrations, bindDatabase, openDatabase, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { membersMigration } from "../../src/storage/schema/members.js";
import { settingsMigration } from "../../src/storage/schema/settings.js";
import { conversationsMigration } from "../../src/storage/schema/conversations.js";
import { executionMigration } from "../../src/storage/schema/execution.js";
import { memberArchivesMigration } from "../../src/storage/schema/member-archives.js";
import { assetsMigration } from "../../src/storage/schema/assets.js";
import * as registry from "../../src/workspace/member-registry.js";
import * as profile from "../../src/workspace/member-profile.js";
import * as wizard from "../../src/workspace/member-archive.js";
import { MemberArchiveService, resolveMemberArtifactPath, resolveMemberDocumentPath } from "../../src/workspace/member-archive-lifecycle.js";
import { MemberArchivesRepository } from "../../src/storage/repositories/member-archives.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { BackgroundRepository } from "../../src/storage/repositories/background-repository.js";
import { SshCredentialsRepository, WorkspacesRepository } from "../../src/storage/repositories/workspace-settings.js";

let root: string;
let db: Database;
let failRename = false;
let failSyncAfterRename = false;
let moved = false;
let forcedUUID: string | undefined;
vi.mock("../../src/shared/config.js", () => ({getBossmodeDir: () => root}));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return {...actual, randomUUID: () => forcedUUID ?? actual.randomUUID()};
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return {...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failRename) throw new Error("injected rename failure");
      actual.renameSync(...args); moved = true;
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      if (moved && failSyncAfterRename) throw new Error("injected sync failure");
      return actual.fsyncSync(...args);
    },
  };
});
const migrations = [baseStorageMigration, membersMigration, settingsMigration, conversationsMigration, executionMigration, assetsMigration, memberArchivesMigration];
function reopen(): void {
  db.close(); db = openDatabase(join(root, "bossmode.db")); applyStorageMigrations(db, migrations); bindDatabase(db);
}
function file(path: string, content: string): string {
  mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, content); return path;
}
function service(quiesce: (id:string) => Promise<void> = async () => {}): MemberArchiveService {
  return new MemberArchiveService(db, root, {quiesce});
}
// E is not merged. Exercise the exact SQL-only adapter seam using a base-schema test marker,
// not a document/history file fallback or a claim of E integration coverage.
function importArchive(opts: Parameters<typeof wizard.importMemberFromArchive>[0]) {
  return wizard.importMemberFromArchive(opts, {commitPersona: (tx, prepared) => {
    expect(() => tx.assertOutsideTransaction()).toThrow(/enclosing/);
    tx.run("INSERT INTO storage_meta(key,value) VALUES(?,?)", `test-persona:${prepared.identity.memberId}`, JSON.stringify(prepared));
  }});
}
function record(id = "mem_import", name = "Imported"): registry.MemberRecord {
  return {id,name,title:"Engineer",agentTemplate:"general",global:{model:"p/m",credentialId:"chosen",skills:["one"]},
    unifiedModel:true,unifiedExtensions:true,scopeOverrides:{},createdAt:1,updatedAt:2};
}
function background(memberId: string, status: "starting" | "done" = "done") {
  const taskId = `bgt-${randomUUID()}`;
  const dir = join(root,"members",memberId,"background-tasks","2026-09-09",taskId);
  file(join(dir,"session.jsonl"),"SDK background\r\n");
  return {taskId,memberId,scopeId:`dm:${memberId}`,kind:"generic" as const,sessionMode:"new" as const,prompt:"do not replay",
    snapshot:{model:null,credentialId:null,thinkingLevel:null},status,startedAt:"2026-09-09T00:00:00Z",
    endedAt:status === "done" ? "2026-09-09T00:00:01Z" : null,result:status === "done" ? "literal answer" : null,error:null,
    sessionDir:dir,parentSessionRef:null};
}
beforeEach(() => {
  failRename = false; failSyncAfterRename = false; moved = false; forcedUUID = undefined;
  root = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!,"members-"));
  mkdirSync(join(root,"knowledge"));
  db = openDatabase(join(root,"bossmode.db")); applyStorageMigrations(db,migrations); bindDatabase(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root,{recursive:true,force:true}); });

describe("explicit member authority and birth", () => {
  it("never initializes from a getter or consults retired JSON", () => {
    file(join(root,"members/mem_legacy/member.json"),JSON.stringify(record("mem_legacy")));
    expect(registry.listMembers()).toEqual([]);
    db.close();
    expect(() => registry.listMembers()).toThrow();
    expect(readFileSync(join(root,"members/mem_legacy/member.json"),"utf8")).toContain("Imported");
    db = openDatabase(join(root,"bossmode.db")); bindDatabase(db);
  });
  it("prepares literal persona and atomically commits identity, DM, workspace and SSH", () => {
    const persona = "\ufeff  ---\r\nname: Not identity\r\n---\r\n内 文  \r\n\n";
    const member = registry.createMemberWithPersona({name:"  言 实  ",title:" Engineer ",credentialId:"account",model:"p/m",skills:["a"],mcpServers:["b"]},persona);
    expect(member).toMatchObject({name:"言 实",title:"Engineer",global:{credentialId:"account",model:"p/m",skills:["a"],mcpServers:["b"]}});
    expect(db.get("SELECT kind,member_id FROM scopes WHERE id=?",`dm:${member.id}`)).toEqual({kind:"dm",member_id:member.id});
    expect(new WorkspacesRepository(db).read(member.id)?.active).toBe("original");
    expect(new SshCredentialsRepository(db).read(member.id)?.publicKey).toMatch(/^ssh-ed25519 /);
    expect(profile.readMemberProfile(member.id).body).toBe(persona);
    expect(profile.formatMemberPromptSegment(profile.readMemberProfile(member.id),member.name)).toBe(`# Member\n\nI am 言 实.\n\n${persona.trim()}`);
    expect(existsSync(join(registry.memberDir(member.id),"member.json"))).toBe(false);
    reopen(); expect(registry.getMember(member.id)).toEqual(member);
  });
  it.each(["all"," USER ","SyStEm"])("reserves creation, rename and import names: %s", name => {
    expect(() => registry.createMember({name})).toThrow("reserved_member_name");
    const m = registry.createMember({name:"Allowed"});
    expect(() => registry.updateMemberIdentity(m.id,{name})).toThrow("reserved_member_name");
    expect(() => registry.importMemberRecord(record("mem_rejected",name.trim()))).toThrow("reserved_member_name");
  });
  it("preserves Unicode lower-case collision and title/name atomicity", () => {
    const a = registry.createMember({name:"Älice",title:"First"});
    registry.createMember({name:"Bob"});
    expect(() => registry.createMember({name:"äLICE"})).toThrow(registry.MemberNameTakenError);
    expect(() => registry.updateMemberIdentity(a.id,{name:"bob",title:"Changed"})).toThrow(registry.MemberNameTakenError);
    expect(registry.getMember(a.id)).toEqual(a);
    expect(registry.updateMemberIdentity(a.id,{name:"Älice",title:"First"}).updatedAt).toBe(a.updatedAt);
    expect(registry.updateMemberIdentity(a.id,{title:""}).title).toBeUndefined();
    const before = readFileSync(profile.memberProfilePath(a.id));
    registry.renameMember(a.id,"新 名"); expect(readFileSync(profile.memberProfilePath(a.id))).toEqual(before);
  });
  it("keeps accepted global config and rolls back its stale bookkeeping on SQL failure", () => {
    const m = registry.createMember({name:"Global",model:"p/old",skills:["skill"]});
    const dm = `dm:${m.id}` as const;
    registry.applyMemberConfigPatch(m.id,dm,{model:"p/new",credentialId:null,mcpServers:["server"]});
    expect(registry.getEffectiveConfig(m.id,dm)).toMatchObject({model:"p/new",credentialId:null,mcpServers:["server"],skills:["skill"],sources:{model:"global",mcpServers:"global"}});
    const before = registry.getMember(m.id);
    db.exec("CREATE TRIGGER fail_stale BEFORE INSERT ON runtime_checkpoints BEGIN SELECT RAISE(ABORT,'stale failure'); END;");
    expect(() => registry.applyMemberConfigPatch(m.id,dm,{model:"p/fail",mcpServers:[]})).toThrow("stale failure");
    expect(registry.getMember(m.id)).toEqual(before);
  });
  it("imports an explicitly identified tombstone even when its old label is already reused", () => {
    const live = registry.createMember({name:"Old Name"});
    const archived = record("mem_old","Old Name"); const members = new MembersRepository(db);
    db.transaction(() => {
      members.importArchived(archived,"backups/old-explicit",123);
      new ConversationsRepository(db).ensureDmScope(archived.id);
    });
    const source = wizard.catalogFromFiredExport({archivePath:"backups/old-explicit",member:archived});
    new MemberArchivesRepository(db).importCatalog({...source,memberId:archived.id});
    expect(registry.findMemberByName("old name")?.id).toBe(live.id);
    expect(members.getRetained(archived.id)).toEqual(archived);
    expect(() => members.importArchived(archived,"backups/another",123)).toThrow(/UNIQUE/);
  });
  it("strict ID import and DM creation roll back together on conflicting scope owner", () => {
    db.run("INSERT INTO scopes VALUES('dm:mem_import','dm',NULL,'mem_other')");
    expect(() => registry.importMemberRecord(record())).toThrow("Scope ownership cannot change");
    expect(registry.getMember("mem_import")).toBeNull();
    db.run("DELETE FROM scopes");
    registry.importMemberRecord(record());
    expect(() => registry.importMemberRecord(record("mem_import","Other"))).toThrow(/UNIQUE/);
    expect(registry.getMember("mem_import")?.name).toBe("Imported");
  });
  it.each(["memory_documents","workspace_registries","ssh_credentials"])("does not swallow %s DB birth failures or leave a partial member", table => {
    db.exec(`CREATE TRIGGER fail_birth BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected birth failure'); END;`);
    expect(() => registry.createMember({name:"Failure"})).toThrow("injected birth failure");
    expect(registry.listMembers()).toEqual([]);
    expect(db.all("SELECT * FROM scopes")).toEqual([]);
    expect(db.all("SELECT * FROM workspace_registries")).toEqual([]);
    expect(db.all("SELECT * FROM ssh_credentials")).toEqual([]);
    expect(db.all("SELECT * FROM memory_documents")).toEqual([]);
    expect(db.all("SELECT * FROM memory_document_history")).toEqual([]);
    expect(readdirSync(join(root,"members"))).toEqual([]);
  });
  it("never clobbers a preexisting newly allocated path", () => {
    forcedUUID = "collision";
    file(join(root,"members/mem_collision/persona.md"),"owned by someone else");
    expect(() => registry.createMember({name:"Collision"})).toThrow(/EEXIST/);
    expect(readFileSync(join(root,"members/mem_collision/persona.md"),"utf8")).toBe("owned by someone else");
    expect(registry.listMembers()).toEqual([]);
  });
  it("rejects file/async operations under ambient transactions, including raw BEGIN", () => {
    expect(() => db.transaction(() => registry.createMember({name:"bad"}))).toThrow(/enclosing/);
    expect(() => db.transaction(() => service().archive("mem_any",{confirm:true}))).toThrow(/enclosing/);
    db.exec("BEGIN");
    expect(() => registry.createMemberWithPersona({name:"bad"},"x")).toThrow(/enclosing/);
    expect(() => profile.readMemberProfile("mem_any")).toThrow(/enclosing/);
    db.exec("ROLLBACK"); expect(registry.listMembers()).toEqual([]);
  });
});

describe("durable quiescent archive and recovery", () => {
  it("persists pending admission before awaiting quiescence; duplicate callers share one operation", async () => {
    const m = registry.createMember({name:"Active"});
    let release!: () => void;
    const quiesce = vi.fn(async () => new Promise<void>(r => {release=r;}));
    const s = service(quiesce);
    const first = s.archive(m.id,{confirm:true});
    expect(s.admission(m.id)).toBe("pending");
    expect(() => s.assertAdmission(m.id)).toThrow("member_admission_pending");
    expect(s.pending()).toHaveLength(1);
    expect(() => resolveMemberArtifactPath(db,root,m.id,"persona.md")).toThrow("member_archive_pending");
    const second = service(quiesce).archive(m.id,{confirm:true}); expect(second).toBe(first);
    expect(existsSync(registry.memberDir(m.id))).toBe(true);
    expect(existsSync(join(root,s.pending()[0].archivePath))).toBe(false);
    release(); const result = await first;
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(s.admission(m.id)).toBe("archived"); expect(s.pending()).toEqual([]);
    expect(existsSync(join(root,result.archived,"persona.md"))).toBe(true);
    expect(existsSync(join(root,result.archived,"member.json"))).toBe(false);
    expect(await s.archive(m.id,{confirm:true})).toEqual(result);
  });
  it("keeps identity, terminal records, SDK bytes and B historical snapshots while allowing name reuse", async () => {
    const m = registry.createMemberWithPersona({name:"Archive Me",title:"Engineer"}," \r\nPersona  \r\n");
    const other = registry.createMember({name:"Other"});
    const conversations = new ConversationsRepository(db);
    const historical = {id:"old-local",roomId:"r",name:"old label",sourceAgent:"general",sourceMemberId:m.id,createdAt:1,updatedAt:2};
    conversations.upsertRoom({id:"r",name:"Room",createdAt:1,members:["historical label"],globalMemberIds:[m.id,other.id],
      roomMembers:[historical],promptLeaderMemberId:m.id,promptLeaderGlobalMemberId:m.id});
    const session = "sessions/2026-09-09/rooms/r/sdk.jsonl";
    file(join(registry.memberDir(m.id),session),'{"type":"session","id":"unchanged"}\r\n');
    new SessionRepository(db).importAssociation({memberId:m.id,scopeId:"r",referenceKind:"member-relative",createdAt:1,updatedAt:2,
      session:{runtime:"pi-sdk",sessionId:"unchanged",sessionFile:session}});
    const task = background(m.id); new BackgroundRepository(db).importRecord(task);
    const logicalSnapshot = `members/${m.id}/history/persona/hash.md`; file(join(root,logicalSnapshot),"historical E bytes");
    const before = db.all("SELECT * FROM background_tasks");
    const result = await service().archive(m.id,{confirm:true});
    expect(registry.getMember(m.id)).toBeNull();
    expect(new MembersRepository(db).getRetained(m.id)).toEqual(m);
    expect(db.all("SELECT * FROM background_tasks")).toEqual(before);
    expect(() => db.run("DELETE FROM members WHERE id=?",m.id)).toThrow(/FOREIGN KEY/);
    expect(new SessionRepository(db).get(m.id,"r")?.session.sessionFile).toBe(session);
    expect(readFileSync(resolveMemberArtifactPath(db,root,m.id,session),"utf8")).toContain("unchanged");
    expect(readFileSync(join(resolveMemberArtifactPath(db,root,m.id,task.sessionDir),"session.jsonl"),"utf8")).toBe("SDK background\r\n");
    expect(readFileSync(resolveMemberDocumentPath(db,root,m.id,logicalSnapshot),"utf8")).toBe("historical E bytes");
    expect(conversations.getRoom("r")).toMatchObject({globalMemberIds:[other.id],roomMembers:[historical],members:["historical label"]});
    expect(conversations.getRoom("r")?.promptLeaderMemberId).toBeUndefined();
    expect(registry.createMember({name:m.name}).id).not.toBe(m.id);
    expect(wizard.listArchives()).toMatchObject([{name:m.name,archivePath:result.archived,kind:"fired",hasPersona:true}]);
    reopen(); expect(wizard.listArchives()).toHaveLength(1);
    expect(readFileSync(resolveMemberArtifactPath(db,root,m.id,join(root,"members",m.id,"persona.md")),"utf8")).toBe(" \r\nPersona  \r\n");
  });
  it("detaches proven local-roster IDs but preserves unrelated same-label records and global historical shadows", async () => {
    const m = registry.createMember({name:"Shared label"});
    const conversations = new ConversationsRepository(db);
    const target = {id:"local-target",roomId:"local",name:m.name,sourceAgent:"general",sourceMemberId:m.id,createdAt:1,updatedAt:2};
    const unrelated = {...target,id:"local-unrelated",sourceMemberId:"mem_someone_else"};
    conversations.upsertRoom({id:"local",name:"Local roster",createdAt:1,members:[m.name],roomMembers:[target,unrelated],promptLeaderMemberId:target.id});
    await service().archive(m.id,{confirm:true});
    expect(conversations.getRoom("local")?.roomMembers).toEqual([unrelated]);
    expect(conversations.getRoom("local")?.promptLeaderMemberId).toBeUndefined();
  });
  it("refuses nonterminal backgrounds after quiesce and can recover after caller interruption", async () => {
    const m = registry.createMember({name:"Busy"}); const task = background(m.id,"starting");
    new BackgroundRepository(db).create(task);
    await expect(service().archive(m.id,{confirm:true})).rejects.toThrow("member_backgrounds_not_terminal");
    expect(existsSync(registry.memberDir(m.id))).toBe(true);
    new BackgroundRepository(db).interruptIncomplete("2026-09-09T00:01:00Z");
    reopen(); await service().recoverPending();
    expect(service().admission(m.id)).toBe("archived");
    expect(new BackgroundRepository(db).get(m.id,task.taskId)?.status).toBe("interrupted");
  });
  it("quiesce failure leaves assets in place and the persisted admission block survives reopen", async () => {
    const m = registry.createMember({name:"Quiesce"});
    await expect(service(async () => {throw new Error("still running");}).archive(m.id,{confirm:true})).rejects.toThrow("still running");
    expect(existsSync(registry.memberDir(m.id))).toBe(true);
    reopen(); expect(service().admission(m.id)).toBe("pending");
    await service().recoverPending(); expect(registry.getMember(m.id)).toBeNull();
  });
  it("intent SQL failure performs neither quiescence nor movement", async () => {
    const m = registry.createMember({name:"Intent"}); const quiesce = vi.fn(async () => {});
    db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON member_archive_intents BEGIN SELECT RAISE(ABORT,'intent failure'); END;");
    await expect(service(quiesce).archive(m.id,{confirm:true})).rejects.toThrow("intent failure");
    expect(quiesce).not.toHaveBeenCalled(); expect(existsSync(registry.memberDir(m.id))).toBe(true);
    expect(service().admission(m.id)).toBe("active");
  });
  it.each(["rename","sync","SQL"])("recovers after %s failure without claiming success or rewriting retained files", async phase => {
    const m = registry.createMemberWithPersona({name:"Crash"},"unchanged\r\n");
    if (phase === "rename") failRename = true;
    if (phase === "sync") failSyncAfterRename = true;
    if (phase === "SQL") db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON member_archives BEGIN SELECT RAISE(ABORT,'catalog failure'); END;");
    await expect(service().archive(m.id,{confirm:true})).rejects.toThrow();
    expect(registry.getMember(m.id)).toEqual(m); expect(wizard.listArchives()).toEqual([]);
    const intent = service().pending()[0];
    expect(existsSync(registry.memberDir(m.id))).toBe(phase === "rename");
    failRename = false; failSyncAfterRename = false;
    if (phase === "SQL") db.exec("DROP TRIGGER fail_archive");
    reopen(); await service().recoverPending();
    expect(readFileSync(join(root,intent.archivePath,"persona.md"),"utf8")).toBe("unchanged\r\n");
    expect(wizard.listArchives()).toHaveLength(1);
  });
  it.each(["both","neither","replaced","symlink"])("fails closed on %s path conflict", async conflict => {
    const m = registry.createMember({name:"Conflict"});
    await expect(service(async () => {throw new Error("stop");}).archive(m.id,{confirm:true})).rejects.toThrow("stop");
    const intent = service().pending()[0];
    const dest = join(root,intent.archivePath); const source = registry.memberDir(m.id);
    if (conflict === "both") file(join(dest,"sentinel"),"do not overwrite");
    if (conflict === "neither") renameSync(source,join(root,"quarantined"));
    if (conflict === "replaced") {renameSync(source,join(root,"quarantined")); mkdirSync(source);}
    if (conflict === "symlink") {renameSync(source,join(root,"quarantined")); symlinkSync(join(root,"quarantined"),source);}
    await expect(service().recoverPending()).rejects.toThrow(/conflict/);
    expect(registry.getMember(m.id)).toEqual(m);
    if (conflict === "both") expect(readFileSync(join(dest,"sentinel"),"utf8")).toBe("do not overwrite");
  });
  it("rejects escaped relative artifacts and leaves unrelated absolute session references unchanged", () => {
    expect(() => resolveMemberArtifactPath(db,root,"mem_any","../../outside")).toThrow(/outside_root/);
    const external = join(root,"rooms/r/pi-sessions/old.jsonl");
    expect(resolveMemberArtifactPath(db,root,"mem_any",external)).toBe(external);
    expect(() => resolveMemberDocumentPath(db,root,"mem_any","../escape")).toThrow(/invalid/);
  });
});

describe("DB archive catalog and explicit source import", () => {
  it("does not scan or read legacy metadata during normal listing/import; explicit null overrides archived credential", () => {
    const path = "backups/fired-export";
    file(join(root,path,"member.json"),"malformed legacy JSON is inert");
    file(join(root,path,"persona.md"),"  ---\nname: literal\n---\n  Body\r\n ");
    expect(wizard.listArchives()).toEqual([]);
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path, member:record("mem_retired","Old Name"),
      persona:{path:`${path}/persona.md`,format:"plain",hasContent:true}}));
    expect(new MemberArchivesRepository(db).list()[0].memberId).toBeUndefined();
    const m = importArchive({archivePath:path,name:"New Name",credentialId:null,agentTemplate:"chosen",global:{model:"chosen/model"}});
    expect(m.id).not.toBe("mem_retired"); expect(m).toMatchObject({name:"New Name",title:"Engineer",agentTemplate:"chosen",global:{credentialId:null,model:"chosen/model",skills:["one"]}});
    expect(profile.readMemberProfile(m.id).raw).toBe("  ---\nname: literal\n---\n  Body\r\n ");
    expect(readFileSync(join(root,path,"member.json"),"utf8")).toContain("malformed");
    expect(() => importArchive({archivePath:path,name:"new name"})).toThrow(registry.MemberNameTakenError);
    expect(registry.listMembers()).toHaveLength(1);
  });
  it("retains legacy wizard grouping and explicit source selection without name-to-ID inference", () => {
    const path = "backups/legacy-old"; file(join(root,path,"rooms/r/principles.md"),"legacy persona\r\n");
    const sources = wizard.catalogFromLegacyManifest({archivePath:path,members:[
      {name:"Old",sourceAgent:"writer",credentialId:"hint",personaPath:`${path}/rooms/r/principles.md`,rooms:[{room:"r",hasPrinciples:true}],conflicts:["first"]},
      {name:"Old",rooms:[{room:"s",hasMainline:true}],conflicts:["second"]}, {name:"Another"},
    ]});
    for (const source of sources) new MemberArchivesRepository(db).importCatalog(source);
    registry.importMemberRecord(record("mem_live","Old"));
    expect(new MemberArchivesRepository(db).list().every(s => !s.memberId)).toBe(true);
    expect(wizard.listArchives().find(s => s.name === "Old")).toMatchObject({roomScopes:[{room:"r",hasPrinciples:true},{room:"s",hasMainline:true}],conflicts:["first","second"]});
    expect(() => importArchive({archivePath:path,name:"New"})).toThrow("archive_source_name_required");
    const m = importArchive({archivePath:path,sourceName:"Old",name:"New"});
    expect(profile.readMemberProfile(m.id).body).toBe("legacy persona\r\n");
    expect(m.global.credentialId).toBe("hint"); expect(m.agentTemplate).toBe("writer");
  });
  it("decodes only explicitly tagged old frontmatter, keeps whitespace and imports no old ID", () => {
    const path = "backups/old-profile"; file(join(root,path,"member.md"),"---\r\nname: Wrong\r\ntitle: Old title\r\n---\r\n\r\n  Body  \r\n");
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path,member:{name:"Old",agentTemplate:"general",global:{}},
      persona:{path:`${path}/member.md`,format:"frontmatter",hasContent:true}}));
    const m = importArchive({archivePath:path,name:"Fresh"});
    expect(m.title).toBe("Old title"); expect(profile.readMemberProfile(m.id).body).toBe("\r\n  Body  \r\n");
    expect(existsSync(join(registry.memberDir(m.id),"member.md"))).toBe(false);
  });
  it("missing body, invalid paths, symlinks and DB failures leave no successful partial import", () => {
    const path = "backups/import";
    const source = wizard.catalogFromFiredExport({archivePath:path,member:record(),persona:{path:`${path}/persona.md`,format:"plain",hasContent:true}});
    const repo = new MemberArchivesRepository(db); repo.importCatalog(source);
    expect(() => importArchive({archivePath:path,name:"Missing"})).toThrow(/ENOENT/);
    expect(() => repo.importCatalog({...source,archivePath:"backups/../escape"})).toThrow(/invalid_archive_path/);
    expect(() => repo.importCatalog({...source,name:"Other",personaPath:"backups/outside/p.md"})).toThrow(/outside_root/);
    file(join(root,"external.md"),"external"); mkdirSync(join(root,path),{recursive:true}); symlinkSync(join(root,"external.md"),join(root,path,"persona.md"));
    expect(() => importArchive({archivePath:path,name:"Link"})).toThrow(/symlink/);
    rmSync(join(root,path,"persona.md")); file(join(root,path,"persona.md"),"body");
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON ssh_credentials BEGIN SELECT RAISE(ABORT,'DB import failure'); END;");
    expect(() => importArchive({archivePath:path,name:"DB fails"})).toThrow("DB import failure");
    expect(registry.listMembers()).toEqual([]); expect(db.all("SELECT * FROM scopes")).toEqual([]);
    expect(readdirSync(join(root,"members"))).toEqual([]);
  });
  it("never lets exported global fields override the caller-selected new identity", () => {
    const path = "backups/config-fields";
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path,
      member:{name:"Old",agentTemplate:"general",global:{name:"Injected",agentTemplate:"injected",title:"injected",model:"p/m",credentialId:"retained"} as any}}));
    const m = importArchive({archivePath:path,name:"Chosen",agentTemplate:"selected",global:{credentialId:undefined}});
    expect(m).toMatchObject({name:"Chosen",agentTemplate:"selected",global:{model:"p/m",credentialId:"retained"}});
    expect(m.title).toBeUndefined();
  });
  it("requires E audit integration, preserves its prepared snapshot DTO and rolls back if its commit fails", () => {
    const path = "backups/e-import"; file(join(root,path,"persona.md"),"Exact \r\n");
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path,member:record(),persona:{path:`${path}/persona.md`,format:"plain",hasContent:true}}));
    expect(() => wizard.importMemberFromArchive({archivePath:path,name:"No adapter"})).toThrow("archive_document_integration_required");
    expect(() => wizard.importMemberFromArchive({archivePath:path,name:"Fail adapter"},{commitPersona:(tx,p) => {
      tx.run("INSERT INTO storage_meta VALUES('rolled-back',?)",p.identity.path);
      throw new Error("E metadata failure");
    }})).toThrow("E metadata failure");
    expect(db.get("SELECT * FROM storage_meta WHERE key='rolled-back'")).toBeUndefined();
    expect(registry.listMembers()).toEqual([]); expect(readdirSync(join(root,"members"))).toEqual([]);
    const m = importArchive({archivePath:path,name:"With adapter"});
    const saved = JSON.parse(db.get<{value:string}>("SELECT value FROM storage_meta WHERE key=?",`test-persona:${m.id}`)!.value);
    expect(saved).toMatchObject({identity:{path:`members/${m.id}/persona.md`,layer:"persona",memberId:m.id},event:{reason:"importFromArchive",actorType:"user",revision:1,contentLength:8}});
    expect(readFileSync(join(root,saved.event.snapshotPath),"utf8")).toBe("Exact \r\n");
  });
  it("rejects over-budget imports before creating identity/assets", () => {
    const path = "backups/over-budget"; file(join(root,path,"persona.md"),"x".repeat(4001));
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path,member:record(),persona:{path:`${path}/persona.md`,format:"plain",hasContent:true}}));
    expect(() => importArchive({archivePath:path,name:"Too long"})).toThrow(/exceed its budget/);
    expect(registry.listMembers()).toEqual([]);
  });
  it("rejects over-budget whitespace without requiring a history hook", () => {
    const path = "backups/whitespace-budget"; file(join(root,path,"persona.md")," ".repeat(4001));
    new MemberArchivesRepository(db).importCatalog(wizard.catalogFromFiredExport({archivePath:path,member:record(),persona:{path:`${path}/persona.md`,format:"plain",hasContent:false}}));
    expect(() => wizard.importMemberFromArchive({archivePath:path,name:"Whitespace"})).toThrow(/exceed its budget/);
    expect(registry.listMembers()).toEqual([]);
  });
  it("catalog SQL import rolls back rooms/conflicts and refuses a current-ID association", () => {
    registry.importMemberRecord(record()); const repo = new MemberArchivesRepository(db);
    const source = wizard.catalogFromFiredExport({archivePath:"backups/a",member:record()});
    expect(() => repo.importCatalog({...source,memberId:"mem_import"})).toThrow("archive_identity_not_retained");
    db.exec("CREATE TRIGGER fail_conflict BEFORE INSERT ON member_archive_conflicts BEGIN SELECT RAISE(ABORT,'conflict failure'); END;");
    expect(() => repo.importCatalog({...source,conflicts:["x"],roomScopes:[{room:"r",hasPrinciples:true,hasMainline:false}]})).toThrow("conflict failure");
    expect(repo.list()).toEqual([]); expect(db.all("SELECT * FROM member_archive_rooms")).toEqual([]);
  });
});
