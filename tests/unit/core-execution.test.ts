import { mainSessionDirectory } from "../../src/files/layout.js";
import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLegacyMemberStorageFixture } from "../helpers/legacy-member-storage.js";
import { applyStorageMigrations, bindDatabase, getDatabase, openDatabase, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const executionMigration = getMigration("core-execution-v1");
const memberSessionsMigration = getMigration("core-member-session-v1");
const memberRuntimeStateMigration = getMigration("core-member-runtime-state-v1");
import { importSessionAssociation, readSessionAssociation } from "../../src/member/sessions.js";
import { RuntimeRepository } from "../../src/agent/instance.js";
import { UserCursorRepository } from "../../src/data/repositories/user-cursor-repository.js";
import { ExecutionAttemptRepository } from "../../src/data/repositories/execution-attempt-repository.js";
import { importExecutionAmbiguity } from "../../src/data/repositories/execution-identity.js";
import * as sessions from "../../src/member/sessions.js";
import * as runtime from "../../src/agent/instance.js";
import * as cursors from "../../src/chat/user-read-cursors.js";

let sandbox: string;
let db: Database;

const owner = "mem_owner";
const other = "mem_other";
function sessionFile(member = owner, filename = "session.jsonl"): string {
  const path = join(sandbox, "members", member, "sessions", "2026-09-09", "main", filename);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, '{"type":"session","id":"sdk-id"}\n');
  return path;
}
function restart(): void {
  const path = db.path;
  db.close();
  db = openDatabase(path);
  applyStorageMigrations(db, [baseStorageMigration, executionMigration, memberSessionsMigration, memberRuntimeStateMigration]);
  bindDatabase(db);
}
beforeEach(() => {
  sandbox = process.env.BOSSMODE_DIR!;
  mkdirSync(join(sandbox, "knowledge"), {recursive:true});
  // Frozen historical schema on an absolute isolated path, closed before core
  // opens. No registry getter, default open, production data or SDK IO.
  const path = join(sandbox, "bossmode.db");
  createLegacyMemberStorageFixture(path);
  db = openDatabase(path);
  applyStorageMigrations(db, [baseStorageMigration, executionMigration, memberSessionsMigration, memberRuntimeStateMigration]);
  bindDatabase(db);
  for (const [id, name] of [[owner,"Alice"], [other,"Bob"]]) {
    db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,'test','{}',1,1)", id, name, name.toLowerCase());
    mkdirSync(join(sandbox, "members", id), {recursive:true});
    db.run("INSERT INTO scopes(id,kind,member_id) VALUES(?,'dm',?)", `dm:${id}`, id);
  }
  db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r')");
});
afterEach(async () => {
  await Promise.resolve(); // Drain commit-only listener notifications before closing.
  vi.restoreAllMocks();
  db.close();
  rmSync(sandbox, {recursive:true, force:true});
});

describe("DB member sessions, unchanged SDK files", () => {
  it("stores normalized descriptors, no current.json; reopening/reset never changes SDK bytes", () => {
    const file = sessionFile();
    const bytes = readFileSync(file);
    sessions.saveCurrentSession(owner, {runtime:"pi-sdk",sessionId:"sdk-id",sessionFile:file});
    expect(db.get("SELECT member_id,file_reference,reference_kind FROM current_sessions")).toEqual({member_id:owner,file_reference:"sessions/2026-09-09/main/session.jsonl",reference_kind:"member-relative"});
    expect(existsSync(join(sandbox,"members",owner,"sessions","current.json"))).toBe(false);
    restart();
    expect(sessions.getCurrentSession(owner)).toEqual({runtime:"pi-sdk",sessionId:"sdk-id",sessionFile:file});
    sessions.clearCurrentSession(owner);
    expect(sessions.getCurrentSession(owner)).toBeUndefined();
    expect(readFileSync(file)).toEqual(bytes);
  });
  it("keeps one row per member: a later save replaces the earlier session", () => {
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"first"});
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"second"});
    expect(sessions.getCurrentSession(owner)?.sessionId).toBe("second");
    expect(db.all("SELECT sdk_session_id FROM current_sessions")).toEqual([{sdk_session_id:"second"}]);
  });
  it("keeps members independent and stable over rename", () => {
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"owner-session"});
    sessions.saveCurrentSession(other,{runtime:"pi-sdk",sessionId:"other-session"});
    db.run("UPDATE members SET name='Renamed',name_key='renamed' WHERE id=?",owner);
    db.run("UPDATE members SET name='Alice',name_key='alice' WHERE id=?",other);
    expect(sessions.getCurrentSession(owner)?.sessionId).toBe("owner-session");
    expect(sessions.getCurrentSession(other)?.sessionId).toBe("other-session");
    sessions.clearCurrentSession(owner);
    expect(sessions.getCurrentSession(owner)).toBeUndefined();
    expect(sessions.getCurrentSession(other)?.sessionId).toBe("other-session");
    expect(() => sessions.saveCurrentSession("Alice",{runtime:"pi-sdk"})).toThrow(/Unknown execution member ID/);
    expect(() => sessions.saveCurrentSession("mem_absent",{runtime:"pi-sdk"})).toThrow(/Unknown execution member ID/);
  });
  it("rejects retired layouts, symlink, escaped, and missing references", () => {
    const file = sessionFile();
    const retiredLayout = join(sandbox,"members",owner,"sessions","2026-09-09","rooms","r","one.jsonl");
    mkdirSync(dirname(retiredLayout),{recursive:true});writeFileSync(retiredLayout,"{}\n");
    expect(() => sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionFile:retiredLayout})).toThrow(/outside the member session store/);
    expect(() => sessions.saveCurrentSession("../escape",{runtime:"pi-sdk",sessionFile:file})).toThrow(/Invalid member/);
    const link = join(dirname(file),"link.jsonl"); symlinkSync(file,link);
    expect(() => sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionFile:link})).toThrow(/symlink/);
    const absent = join(dirname(file),"missing.jsonl");
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionFile:absent}); // SDK may prepare before first append.
    expect(() => sessions.getCurrentSession(owner)).toThrow(/is missing/);
    const outside = join(sandbox,"outside"); mkdirSync(outside);
    const escape = join(sandbox,"members",owner,"sessions","2026-09-10"); symlinkSync(outside,escape);
    expect(() => sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionFile:join(escape,"main","a.jsonl")})).toThrow(/escapes/);
  });
  it("imports exact timestamps and legacy SDK references without moving or mirroring history", () => {
    const file = join(sandbox,"rooms/r/pi-sessions/old.jsonl"); mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"old-sdk-bytes\n");
    const repo = db;
    importSessionAssociation({memberId:owner,referenceKind:"legacy-absolute",createdAt:123,updatedAt:456,
      session:{runtime:"pi-sdk",sessionId:"old-id",sessionFile:file}}, repo);
    expect(readSessionAssociation(owner, repo)).toMatchObject({createdAt:123,updatedAt:456});
    expect(sessions.getCurrentSession(owner)?.sessionFile).toBe(file);
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"old-id",sessionFile:file});
    expect(readSessionAssociation(owner, repo)).toMatchObject({referenceKind:"legacy-absolute",createdAt:123});
    expect(readFileSync(file,"utf8")).toBe("old-sdk-bytes\n");
    expect(db.all("SELECT name FROM sqlite_master WHERE name LIKE '%session%' AND type='table'")).toEqual([{name:"current_sessions"}]);
  });
  it("keeps real SDK create/open/context/fork behavior file-backed across DB reopen", async () => {
    const {SessionManager} = await import("@earendil-works/pi-coding-agent");
    const dir = mainSessionDirectory(owner);mkdirSync(dir,{recursive:true});
    const manager=SessionManager.create(sandbox,dir);
    manager.appendMessage({role:"user",content:[{type:"text",text:"original user context"}]} as any);
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"original answer"}]} as any);
    const file=manager.getSessionFile()!;
    const bytes=readFileSync(file);
    const context=JSON.stringify(manager.buildSessionContext());
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:manager.getSessionId(),sessionFile:file});
    restart();
    const association=sessions.getCurrentSession(owner)!;
    const opened=SessionManager.open(association.sessionFile!,dir,sandbox);
    expect(opened.getSessionId()).toBe(manager.getSessionId());
    expect(JSON.stringify(opened.buildSessionContext())).toBe(context);
    const fork=SessionManager.forkFrom(file,sandbox,dir);
    expect(JSON.stringify(fork.buildSessionContext())).toBe(context);
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:fork.getSessionId(),sessionFile:fork.getSessionFile()!});
    fork.appendMessage({role:"user",content:[{type:"text",text:"continuation"}]} as any);
    fork.appendMessage({role:"assistant",content:[{type:"text",text:"answer"}]} as any);
    expect(readFileSync(file)).toEqual(bytes);
    expect(sessions.getCurrentSession(owner)?.sessionId).toBe(fork.getSessionId());
    sessions.clearCurrentSession(owner);
    expect(existsSync(fork.getSessionFile()!)).toBe(true);
    expect(sessions.getCurrentSession(owner)).toBeUndefined();
  });
  it("rejects malformed pure-import archive references and non-file SDK references", () => {
    const repo=db;
    expect(() => importSessionAssociation({memberId:owner,referenceKind:"member-relative",createdAt:1,updatedAt:2,
      session:{runtime:"pi-sdk",sessionFile:"sessions/2026-09-09/rooms/other/wrong.jsonl"}}, repo)).toThrow(/does not match the member session archive/);
    const fake=join(sandbox,"members",owner,"sessions/2026-09-09/main/directory.jsonl");mkdirSync(fake,{recursive:true});
    expect(() => sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionFile:fake})).toThrow(/not a file/);
  });
  it("does not read legacy current.json on get or preserve it as a shadow", () => {
    const legacyDir=join(sandbox,"members",owner,"sessions"); mkdirSync(legacyDir,{recursive:true});
    const legacy=join(legacyDir,"current.json");
    writeFileSync(legacy,"broken");
    expect(sessions.getCurrentSession(owner)).toBeUndefined();
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk"});
    expect(readFileSync(legacy,"utf8")).toBe("broken");
  });
  it("rolls back failed association writes with no file mutation or successful fallback", () => {
    const file=sessionFile();
    sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"first",sessionFile:file});
    db.exec("CREATE TRIGGER reject_session BEFORE UPDATE ON current_sessions BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => sessions.saveCurrentSession(owner,{runtime:"pi-sdk",sessionId:"second",sessionFile:file})).toThrow(/injected/);
    expect(sessions.getCurrentSession(owner)?.sessionId).toBe("first");
  });
});

describe("runtime checkpoints and numeric user cursor semantics", () => {
  it("normalizes fields, merges stale mounts, clears drift, and survives reopen (member-level)", () => {
    runtime.markStaleMounts(owner,["mcpServers"]);
    runtime.markStaleMounts(owner,["mcpServers","extensions"]);
    runtime.markDriftNotified(owner,9);
    runtime.setContractFingerprint(owner,"hash",10);
    restart();
    expect(runtime.getRuntimeStateEntry(owner)).toMatchObject({contractFingerprint:"hash",contractVersion:10,staleMounts:{fields:["mcpServers","extensions"]}});
    expect(runtime.getRuntimeStateEntry(owner).driftNotified).toBeUndefined();
    expect(Object.keys(runtime.readRuntimeState())).toEqual([owner]);
    runtime.clearStaleMounts(owner);
    expect(db.all("SELECT * FROM runtime_stale_fields")).toEqual([]);
    runtime.clearRuntimeStateEntry(owner);
    expect(runtime.getRuntimeStateEntry(owner)).toEqual({});
    expect(existsSync(join(sandbox,"rooms/r/runtime-state.json"))).toBe(false);
  });
  it("imports normalized runtime records with timestamps; failure rolls back child fields", () => {
    const repo=new RuntimeRepository(db);
    repo.importEntry(owner,{contractFingerprint:"original",staleMounts:{since:100,fields:["one"]}},101);
    db.exec("CREATE TRIGGER reject_fields BEFORE INSERT ON runtime_stale_fields WHEN NEW.field='bad' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => repo.importEntry(owner,{contractFingerprint:"changed",staleMounts:{since:200,fields:["two","bad"]}},201)).toThrow(/injected/);
    expect(repo.get(owner)).toEqual({contractFingerprint:"original",staleMounts:{since:100,fields:["one"]}});
    expect(db.get("SELECT updated_at FROM runtime_checkpoints")).toEqual({updated_at:101});
    runtime.clearStaleMounts(owner);
    expect(repo.get(owner)).toMatchObject({contractFingerprint:"original"});
    expect(repo.get(owner).staleMounts).toBeUndefined();
    runtime.clearStaleMounts("mem_missing");
    expect(db.all("SELECT * FROM runtime_checkpoints WHERE member_id='mem_missing'")).toEqual([]);
  });
  it("keeps user numeric seq as TEXT and message ID separate, preserving null, zero and partial patches", () => {
    db.run("INSERT INTO read_cursors VALUES('r','member',?,'member-message',1)",owner);
    cursors.setUserReadCursor("room:r",{messageId:"m-1",seq:0});
    expect(db.get("SELECT value,typeof(value) AS storage_type FROM read_cursors WHERE kind='user'")).toEqual({value:"0",storage_type:"text"});
    cursors.setUserReadCursor("room:r",{seq:42});
    expect(cursors.getUserReadCursor("room:r")).toMatchObject({messageId:"m-1",seq:42});
    cursors.setUserReadCursor("room:r",{messageId:null});
    expect(cursors.getUserReadCursor("room:r")).toMatchObject({messageId:null,seq:42});
    cursors.setUserReadCursor("room:r",{seq:null});
    expect(cursors.getUserReadCursor("room:r")).toMatchObject({messageId:null,seq:null});
    expect(db.get("SELECT value FROM read_cursors WHERE kind='member'")).toEqual({value:"member-message"});
    expect(cursors.getUserReadCursor("invalid")).toBeNull();
    expect(() => cursors.setUserReadCursor("invalid",{seq:1})).toThrow(/scope_not_found/);
  });
  it("imports user cursors preserving time/numbers and room/DM unread keys without reading files", () => {
    const repo=new UserCursorRepository(db);
    for(const scope of ["room:r",`dm:${owner}`]) repo.importCursor(scope,{seq:123.5,messageId:"unchanged-id",updatedAt:789});
    writeFileSync(join(sandbox,"user-read-cursors.json"),JSON.stringify({"room:r":{seq:999}}));
    restart();
    expect(cursors.listUserReadCursors()).toEqual(Object.fromEntries(["room:r",`dm:${owner}`].map(s=>[s,{seq:123.5,messageId:"unchanged-id",updatedAt:789}])));
    expect(existsSync(join(sandbox,"user-read-cursors.json"))).toBe(true);
  });
  it("atomically rolls back user seq if message metadata write fails", () => {
    cursors.setUserReadCursor("room:r",{messageId:"old",seq:1});
    db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON user_cursor_messages BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => cursors.setUserReadCursor("room:r",{messageId:"new",seq:2})).toThrow(/injected/);
    expect(cursors.getUserReadCursor("room:r")).toMatchObject({messageId:"old",seq:1});
  });
});

describe("recovery attempts and unresolved legacy names", () => {
  it("checkpoints explicit acknowledgement, immutable completion and unknown restart outcomes", () => {
    const repo=new ExecutionAttemptRepository(db);
    for(const id of ["prepared","dispatched","acknowledged"]) repo.prepare({id,memberId:owner,scopeId:"room:r",operation:"input",externalReference:"source-message",startedAt:123});
    repo.markDispatched("dispatched",owner,124);repo.markDispatched("acknowledged",owner,124);repo.acknowledge("acknowledged",owner,125);
    expect(() => repo.acknowledge("prepared",owner,125)).toThrow(/rejected/);
    expect(() => repo.acknowledge("dispatched",other,125)).toThrow(/rejected/);
    expect(repo.interruptIncomplete(200)).toBe(2);expect(repo.interruptIncomplete(201)).toBe(0);
    expect(repo.get("prepared",owner)).toMatchObject({status:"interrupted",startedAt:123,endedAt:200,diagnosis:expect.stringContaining("uncertain")});
    expect(repo.get("acknowledged",owner)?.status).toBe("acknowledged");
    expect(() => repo.markDispatched("prepared",owner,202)).toThrow(/rejected/);
  });
  it("quarantines ambiguous legacy source keys explicitly instead of binding a reused modern name", () => {
    const entry={sourcePath:"rooms/r/sessions.json",sourceKey:"Alice",domain:"session" as const,reason:"unresolved legacy display name",
      recordJson:JSON.stringify({runtime:"pi-sdk",sessionId:"historical"}),importedAt:123};
    importExecutionAmbiguity(db,entry);importExecutionAmbiguity(db,entry);
    expect(db.get("SELECT source_key,reason,imported_at FROM execution_import_ambiguities")).toEqual({source_key:"Alice",reason:entry.reason,imported_at:123});
    expect(sessions.getCurrentSession(owner,"r")).toBeUndefined();
    expect(sessions.getCurrentSession(other,"r")).toBeUndefined();
  });
});
