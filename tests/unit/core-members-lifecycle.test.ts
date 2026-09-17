import { formatMemberPromptSegment } from "../../src/agent/prompt.js";
import { detachMemberFromConversations } from "../../src/chat/conversations.js";
import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyStorageMigrations, bindDatabase, openDatabase, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const membersMigration = getMigration("core-members-v1");
const settingsMigration = getMigration("core-settings-v1");
const conversationsMigration = getMigration("core-conversations-v1");
const executionMigration = getMigration("core-execution-v1");
import { memberDir, memberProfilePath } from "../../src/files/layout.js";
const memberArchivesMigration = getMigration("core-member-archives-v1");
const assetsMigration = getMigration("core-assets-v1");
const memberSessionsMigration = getMigration("core-member-session-v1");
const memberRuntimeStateMigration = getMigration("core-member-runtime-state-v1");
const roomDescriptionMigration = getMigration("core-room-description-v1");
import * as registry from "../../src/member/identity.js";
import * as __registry_app_member_actions from "../../src/app/member-actions.js";
import * as profile from "../../src/member/profile.js";
import * as wizard from "../../src/app/upgrade/assets.js";
import { MemberArchiveService, resolveMemberArtifactPath, resolveMemberDocumentPath } from "../../src/member/archive.js";
import { importMemberArchiveCatalog, listMemberArchiveCatalog } from "../../src/member/archive.js";
import { importArchivedMember, getRetainedMember } from "../../src/member/identity.js";
import { ensureDmScope, storeRoom, readStoredRoom } from "../../src/chat/conversations.js";
import { importSessionAssociation, readSessionAssociation } from "../../src/member/sessions.js";
import { readWorkspaceRegistry, readSshCredential } from "../../src/member/workspaces.js";

let root: string;
let db: Database;
let failRename = false;
let failSyncAfterRename = false;
let moved = false;
let forcedUUID: string | undefined;
let forcedIdDraw: number | undefined;

vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  const drawInt = actual.randomInt as unknown as (...args: number[]) => number;
  return {...actual,
    randomUUID: () => forcedUUID ?? actual.randomUUID(),
    // Short-id draws (member/room ids) route through randomInt; forcing a constant
    // draw makes the next minted id predictable for collision tests.
    randomInt: (...args: number[]) => forcedIdDraw ?? drawInt(...args),
  };
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
const migrations = [baseStorageMigration, membersMigration, settingsMigration, conversationsMigration, executionMigration, assetsMigration, memberArchivesMigration, memberSessionsMigration, memberRuntimeStateMigration, roomDescriptionMigration];
function reopen(): void {
  db.close(); db = openDatabase(join(root, "bossmode.db")); applyStorageMigrations(db, migrations); bindDatabase(db);
}
function file(path: string, content: string): string {
  mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, content); return path;
}
function service(quiesce: (id:string) => Promise<void> = async () => {}): MemberArchiveService {
  return new MemberArchiveService(db, root, { detachFromConversations: detachMemberFromConversations, quiesce});
}
function record(id = "mem_import", name = "Imported"): registry.MemberRecord {
  return {id,name,title:"Engineer",agentTemplate:"general",global:{model:"p/m",credentialId:"chosen",skills:["one"]},
    unifiedModel:true,unifiedExtensions:true,scopeOverrides:{},createdAt:1,updatedAt:2};
}
beforeEach(() => {
  failRename = false; failSyncAfterRename = false; moved = false; forcedUUID = undefined; forcedIdDraw = undefined;
  root = process.env.BOSSMODE_DIR!;
  mkdirSync(join(root,"knowledge"), {recursive:true});
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
    const member = __registry_app_member_actions.createMemberWithPersona({name:"  言 实  ",title:" Engineer ",credentialId:"account",model:"p/m",skills:["a"],mcpServers:["b"]},persona);
    expect(member).toMatchObject({name:"言 实",title:"Engineer",global:{credentialId:"account",model:"p/m",skills:["a"],mcpServers:["b"]}});
    expect(db.get("SELECT kind,member_id FROM scopes WHERE id=?",`dm:${member.id}`)).toEqual({kind:"dm",member_id:member.id});
    expect(readWorkspaceRegistry(member.id, db)?.active).toBe("original");
    expect(readSshCredential(member.id, db)?.publicKey).toMatch(/^ssh-ed25519 /);
    expect(profile.readMemberProfile(member.id).body).toBe(persona);
    expect(formatMemberPromptSegment(profile.readMemberProfile(member.id),member.name)).toBe(`# Persona\n\nI am 言 实, an AI teammate in Bossmode.\n\n${persona.trim()}`);
    expect(existsSync(join(memberDir(member.id),"member.json"))).toBe(false);
    reopen(); expect(registry.getMember(member.id)).toEqual(member);
  });
  it.each(["all"," USER ","SyStEm"])("reserves creation, rename and import names: %s", name => {
    expect(() => __registry_app_member_actions.createMember({name})).toThrow("reserved_member_name");
    const m = __registry_app_member_actions.createMember({name:"Allowed"});
    expect(() => registry.updateMemberIdentity(m.id,{name})).toThrow("reserved_member_name");
    expect(() => __registry_app_member_actions.importMemberRecord(record("mem_rejected",name.trim()))).toThrow("reserved_member_name");
  });
  it("preserves Unicode lower-case collision and title/name atomicity", () => {
    const a = __registry_app_member_actions.createMember({name:"Älice",title:"First"});
    __registry_app_member_actions.createMember({name:"Bob"});
    expect(() => __registry_app_member_actions.createMember({name:"äLICE"})).toThrow(registry.MemberNameTakenError);
    expect(() => registry.updateMemberIdentity(a.id,{name:"bob",title:"Changed"})).toThrow(registry.MemberNameTakenError);
    expect(registry.getMember(a.id)).toEqual(a);
    expect(registry.updateMemberIdentity(a.id,{name:"Älice",title:"First"}).updatedAt).toBe(a.updatedAt);
    expect(registry.updateMemberIdentity(a.id,{title:""}).title).toBeUndefined();
    const before = readFileSync(memberProfilePath(a.id));
    registry.renameMember(a.id,"新 名"); expect(readFileSync(memberProfilePath(a.id))).toEqual(before);
  });
  it("keeps accepted global config and rolls back its stale bookkeeping on SQL failure", () => {
    const m = __registry_app_member_actions.createMember({name:"Global",model:"p/old",skills:["skill"]});
    const dm = `dm:${m.id}` as const;
    registry.applyMemberConfigPatch(m.id,{model:"p/new",credentialId:null,mcpServers:["server"]});
    expect(registry.getMemberConfiguration(m.id)).toMatchObject({model:"p/new",credentialId:null,mcpServers:["server"],skills:["skill"]});
    const before = registry.getMember(m.id);
    db.exec("CREATE TRIGGER fail_stale BEFORE INSERT ON runtime_checkpoints BEGIN SELECT RAISE(ABORT,'stale failure'); END;");
    expect(() => registry.applyMemberConfigPatch(m.id,{model:"p/fail",mcpServers:[]})).toThrow("stale failure");
    expect(registry.getMember(m.id)).toEqual(before);
  });
  it("imports an explicitly identified tombstone even when its old label is already reused", () => {
    const live = __registry_app_member_actions.createMember({name:"Old Name"});
    const archived = record("mem_old","Old Name"); const members = db;
    db.transaction(() => {
      importArchivedMember(archived,"backups/old-explicit",123, members);
      ensureDmScope(archived.id, db);
    });
    const source = wizard.catalogFromFiredExport({archivePath:"backups/old-explicit",member:archived});
    importMemberArchiveCatalog({...source,memberId:archived.id}, db);
    expect(registry.findMemberByName("old name")?.id).toBe(live.id);
    expect(getRetainedMember(archived.id, members)).toEqual(archived);
    expect(() => importArchivedMember(archived,"backups/another",123, members)).toThrow(/UNIQUE/);
  });
  it("strict ID import and DM creation roll back together on conflicting scope owner", () => {
    db.run("INSERT INTO scopes VALUES('dm:mem_import','dm',NULL,'mem_other')");
    expect(() => __registry_app_member_actions.importMemberRecord(record())).toThrow("Scope ownership cannot change");
    expect(registry.getMember("mem_import")).toBeNull();
    db.run("DELETE FROM scopes");
    __registry_app_member_actions.importMemberRecord(record());
    expect(() => __registry_app_member_actions.importMemberRecord(record("mem_import","Other"))).toThrow(/UNIQUE/);
    expect(registry.getMember("mem_import")?.name).toBe("Imported");
  });
  it.each(["memory_documents","workspace_registries","ssh_credentials"])("does not swallow %s DB birth failures or leave a partial member", table => {
    db.exec(`CREATE TRIGGER fail_birth BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected birth failure'); END;`);
    expect(() => __registry_app_member_actions.createMember({name:"Failure"})).toThrow("injected birth failure");
    expect(registry.listMembers()).toEqual([]);
    expect(db.all("SELECT * FROM scopes")).toEqual([]);
    expect(db.all("SELECT * FROM workspace_registries")).toEqual([]);
    expect(db.all("SELECT * FROM ssh_credentials")).toEqual([]);
    expect(db.all("SELECT * FROM memory_documents")).toEqual([]);
    expect(db.all("SELECT * FROM memory_document_history")).toEqual([]);
    expect(readdirSync(join(root,"members"))).toEqual([]);
  });
  it("never clobbers a preexisting newly allocated path", () => {
    forcedIdDraw = 0; // every draw yields `mem_0000000000`; the bounded retry still fails loudly
    file(join(root,"members/mem_0000000000/persona.md"),"owned by someone else");
    expect(() => __registry_app_member_actions.createMember({name:"Collision"})).toThrow(/EEXIST/);
    expect(readFileSync(join(root,"members/mem_0000000000/persona.md"),"utf8")).toBe("owned by someone else");
    expect(registry.listMembers()).toEqual([]);
  });
  it("rejects file/async operations under ambient transactions, including raw BEGIN", () => {
    expect(() => db.transaction(() => __registry_app_member_actions.createMember({name:"bad"}))).toThrow(/enclosing/);
    expect(() => db.transaction(() => service().archive("mem_any",{confirm:true}))).toThrow(/enclosing/);
    db.exec("BEGIN");
    expect(() => __registry_app_member_actions.createMemberWithPersona({name:"bad"},"x")).toThrow(/enclosing/);
    expect(() => profile.readMemberProfile("mem_any")).toThrow(/enclosing/);
    db.exec("ROLLBACK"); expect(registry.listMembers()).toEqual([]);
  });
});

describe("durable quiescent archive and recovery", () => {
  it("persists pending admission before awaiting quiescence; duplicate callers share one operation", async () => {
    const m = __registry_app_member_actions.createMember({name:"Active"});
    let release!: () => void;
    const quiesce = vi.fn(async () => new Promise<void>(r => {release=r;}));
    const s = service(quiesce);
    const first = s.archive(m.id,{confirm:true});
    expect(s.admission(m.id)).toBe("pending");
    expect(() => s.assertAdmission(m.id)).toThrow("member_admission_pending");
    expect(s.pending()).toHaveLength(1);
    expect(() => resolveMemberArtifactPath(db,root,m.id,"persona.md")).toThrow("member_archive_pending");
    const second = service(quiesce).archive(m.id,{confirm:true}); expect(second).toBe(first);
    expect(existsSync(memberDir(m.id))).toBe(true);
    expect(existsSync(join(root,s.pending()[0].archivePath))).toBe(false);
    release(); const result = await first;
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(s.admission(m.id)).toBe("archived"); expect(s.pending()).toEqual([]);
    expect(existsSync(join(root,result.archived,"persona.md"))).toBe(true);
    expect(existsSync(join(root,result.archived,"member.json"))).toBe(false);
    expect(await s.archive(m.id,{confirm:true})).toEqual(result);
  });
  it("keeps identity, SDK bytes and B historical snapshots while allowing name reuse", async () => {
    const m = __registry_app_member_actions.createMemberWithPersona({name:"Archive Me",title:"Engineer"}," \r\nPersona  \r\n");
    const other = __registry_app_member_actions.createMember({name:"Other"});
    const conversations = db;
    const historical = {id:"old-local",roomId:"r",name:"old label",sourceAgent:"general",sourceMemberId:m.id,createdAt:1,updatedAt:2};
    storeRoom({id:"r",name:"Room",createdAt:1,members:["historical label"],globalMemberIds:[m.id,other.id],
      roomMembers:[historical],promptLeaderMemberId:m.id,promptLeaderGlobalMemberId:m.id}, conversations);
    const session = "sessions/2026-09-09/main/sdk.jsonl";
    file(join(memberDir(m.id),session),'{"type":"session","id":"unchanged"}\r\n');
    importSessionAssociation({memberId:m.id,referenceKind:"member-relative",createdAt:1,updatedAt:2,
      session:{runtime:"pi-sdk",sessionId:"unchanged",sessionFile:session}}, db);
    const logicalSnapshot = `members/${m.id}/history/persona/hash.md`; file(join(root,logicalSnapshot),"historical E bytes");
    const result = await service().archive(m.id,{confirm:true});
    expect(registry.getMember(m.id)).toBeNull();
    expect(getRetainedMember(m.id, db)).toEqual(m);
    expect(() => db.run("DELETE FROM members WHERE id=?",m.id)).toThrow(/FOREIGN KEY/);
    expect(readSessionAssociation(m.id, db)?.session.sessionFile).toBe(session);
    expect(readFileSync(resolveMemberArtifactPath(db,root,m.id,session),"utf8")).toContain("unchanged");
    expect(readFileSync(resolveMemberDocumentPath(db,root,m.id,logicalSnapshot),"utf8")).toBe("historical E bytes");
    expect(readStoredRoom("r", conversations)).toMatchObject({globalMemberIds:[other.id],roomMembers:[historical],members:["historical label"]});
    expect(readStoredRoom("r", conversations)?.promptLeaderMemberId).toBeUndefined();
    expect(__registry_app_member_actions.createMember({name:m.name}).id).not.toBe(m.id);
    expect(listMemberArchiveCatalog(db)).toMatchObject([{name:m.name,archivePath:result.archived,kind:"fired",hasPersona:true}]);
    reopen(); expect(listMemberArchiveCatalog(db)).toHaveLength(1);
    expect(readFileSync(resolveMemberArtifactPath(db,root,m.id,join(root,"members",m.id,"persona.md")),"utf8")).toBe(" \r\nPersona  \r\n");
  });
  it("detaches proven local-roster IDs but preserves unrelated same-label records and global historical shadows", async () => {
    const m = __registry_app_member_actions.createMember({name:"Shared label"});
    const conversations = db;
    const target = {id:"local-target",roomId:"local",name:m.name,sourceAgent:"general",sourceMemberId:m.id,createdAt:1,updatedAt:2};
    const unrelated = {...target,id:"local-unrelated",sourceMemberId:"mem_someone_else"};
    storeRoom({id:"local",name:"Local roster",createdAt:1,members:[m.name],roomMembers:[target,unrelated],promptLeaderMemberId:target.id}, conversations);
    await service().archive(m.id,{confirm:true});
    expect(readStoredRoom("local", conversations)?.roomMembers).toEqual([unrelated]);
    expect(readStoredRoom("local", conversations)?.promptLeaderMemberId).toBeUndefined();
  });
  it("quiesce failure leaves assets in place and the persisted admission block survives reopen", async () => {
    const m = __registry_app_member_actions.createMember({name:"Quiesce"});
    await expect(service(async () => {throw new Error("still running");}).archive(m.id,{confirm:true})).rejects.toThrow("still running");
    expect(existsSync(memberDir(m.id))).toBe(true);
    reopen(); expect(service().admission(m.id)).toBe("pending");
    await service().recoverPending(); expect(registry.getMember(m.id)).toBeNull();
  });
  it("intent SQL failure performs neither quiescence nor movement", async () => {
    const m = __registry_app_member_actions.createMember({name:"Intent"}); const quiesce = vi.fn(async () => {});
    db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON member_archive_intents BEGIN SELECT RAISE(ABORT,'intent failure'); END;");
    await expect(service(quiesce).archive(m.id,{confirm:true})).rejects.toThrow("intent failure");
    expect(quiesce).not.toHaveBeenCalled(); expect(existsSync(memberDir(m.id))).toBe(true);
    expect(service().admission(m.id)).toBe("active");
  });
  it.each(["rename","sync","SQL"])("recovers after %s failure without claiming success or rewriting retained files", async phase => {
    const m = __registry_app_member_actions.createMemberWithPersona({name:"Crash"},"unchanged\r\n");
    if (phase === "rename") failRename = true;
    if (phase === "sync") failSyncAfterRename = true;
    if (phase === "SQL") db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON member_archives BEGIN SELECT RAISE(ABORT,'catalog failure'); END;");
    await expect(service().archive(m.id,{confirm:true})).rejects.toThrow();
    expect(registry.getMember(m.id)).toEqual(m); expect(listMemberArchiveCatalog(db)).toEqual([]);
    const intent = service().pending()[0];
    expect(existsSync(memberDir(m.id))).toBe(phase === "rename");
    failRename = false; failSyncAfterRename = false;
    if (phase === "SQL") db.exec("DROP TRIGGER fail_archive");
    reopen(); await service().recoverPending();
    expect(readFileSync(join(root,intent.archivePath,"persona.md"),"utf8")).toBe("unchanged\r\n");
    expect(listMemberArchiveCatalog(db)).toHaveLength(1);
  });
  it.each(["both","neither","replaced","symlink"])("fails closed on %s path conflict", async conflict => {
    const m = __registry_app_member_actions.createMember({name:"Conflict"});
    await expect(service(async () => {throw new Error("stop");}).archive(m.id,{confirm:true})).rejects.toThrow("stop");
    const intent = service().pending()[0];
    const dest = join(root,intent.archivePath); const source = memberDir(m.id);
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

describe("DB archive catalog", () => {
  it("retains legacy manifest grouping without name-to-ID inference", () => {
    const path = "backups/legacy-old"; file(join(root,path,"rooms/r/principles.md"),"legacy persona\r\n");
    const sources = wizard.catalogFromLegacyManifest({archivePath:path,members:[
      {name:"Old",sourceAgent:"writer",credentialId:"hint",personaPath:`${path}/rooms/r/principles.md`,rooms:[{room:"r",hasPrinciples:true}],conflicts:["first"]},
      {name:"Old",rooms:[{room:"s",hasMainline:true}],conflicts:["second"]}, {name:"Another"},
    ]});
    for (const source of sources) importMemberArchiveCatalog(source, db);
    __registry_app_member_actions.importMemberRecord(record("mem_live","Old"));
    expect(listMemberArchiveCatalog(db).every(s => !s.memberId)).toBe(true);
    expect(listMemberArchiveCatalog(db).find(s => s.name === "Old")).toMatchObject({roomScopes:[{room:"r",hasPrinciples:true},{room:"s",hasMainline:true}],conflicts:["first","second"]});
  });
  it("rejects invalid catalog paths", () => {
    const path = "backups/import";
    const source = wizard.catalogFromFiredExport({archivePath:path,member:record(),persona:{path:`${path}/persona.md`,format:"plain",hasContent:true}});
    const repo = db;
    expect(() => importMemberArchiveCatalog({...source,archivePath:"backups/../escape"}, repo)).toThrow(/invalid_archive_path/);
    expect(() => importMemberArchiveCatalog({...source,name:"Other",personaPath:"backups/outside/p.md"}, repo)).toThrow(/outside_root/);
  });
  it("catalog SQL import rolls back rooms/conflicts and refuses a current-ID association", () => {
    __registry_app_member_actions.importMemberRecord(record()); const repo = db;
    const source = wizard.catalogFromFiredExport({archivePath:"backups/a",member:record()});
    expect(() => importMemberArchiveCatalog({...source,memberId:"mem_import"}, repo)).toThrow("archive_identity_not_retained");
    db.exec("CREATE TRIGGER fail_conflict BEFORE INSERT ON member_archive_conflicts BEGIN SELECT RAISE(ABORT,'conflict failure'); END;");
    expect(() => importMemberArchiveCatalog({...source,conflicts:["x"],roomScopes:[{room:"r",hasPrinciples:true,hasMainline:false}]}, repo)).toThrow("conflict failure");
    expect(listMemberArchiveCatalog(repo)).toEqual([]); expect(db.all("SELECT * FROM member_archive_rooms")).toEqual([]);
  });
});

it("rolls back conversation detachment with archive completion and recovers the retained files", async () => {
  const member = __registry_app_member_actions.createMemberWithPersona({ name: "Archive atomicity" }, "keep this persona");
  const rooms = db;
  storeRoom({ id: "archive-room", name: "Archive room", members: [member.name], globalMemberIds: [member.id], createdAt: 1 }, rooms);
  const failing = new MemberArchiveService(db, root, {
    quiesce: async () => {},
    detachFromConversations: (id, tx) => {
      detachMemberFromConversations(id, tx);
      throw new Error("injected membership completion failure");
    },
  });
  await expect(failing.archive(member.id, { confirm: true })).rejects.toThrow("injected membership completion failure");
  expect(registry.getMember(member.id)).not.toBeNull();
  expect(readStoredRoom("archive-room", rooms)?.globalMemberIds).toEqual([member.id]);
  const pending = service().pending()[0];
  expect(pending.memberId).toBe(member.id);
  expect(readFileSync(join(root, pending.archivePath, "persona.md"), "utf8")).toBe("keep this persona");
  reopen();
  await service().recoverPending();
  expect(registry.getMember(member.id)).toBeNull();
  expect(readStoredRoom("archive-room", db)?.globalMemberIds).toEqual([]);
  expect(readFileSync(join(root, pending.archivePath, "persona.md"), "utf8")).toBe("keep this persona");
});
