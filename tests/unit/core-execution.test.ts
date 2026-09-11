import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLegacyMemberStorageFixture } from "../helpers/legacy-member-storage.js";
import { applyStorageMigrations, bindDatabase, getDatabase, openDatabase, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { executionMigration } from "../../src/storage/schema/execution.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { RuntimeRepository } from "../../src/storage/repositories/runtime-repository.js";
import { UserCursorRepository } from "../../src/storage/repositories/user-cursor-repository.js";
import { BackgroundRepository } from "../../src/storage/repositories/background-repository.js";
import { ExecutionAttemptRepository } from "../../src/storage/repositories/execution-attempt-repository.js";
import { importExecutionAmbiguity } from "../../src/storage/repositories/execution-identity.js";
import * as sessions from "../../src/workspace/session-store.js";
import * as runtime from "../../src/workspace/runtime-state.js";
import * as cursors from "../../src/workspace/user-read-cursors.js";
import * as background from "../../src/engine/background-task-store.js";

let sandbox: string;
let db: Database;
let forcedUUID: string | undefined;
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {...actual, randomUUID: () => forcedUUID ?? actual.randomUUID()};
});
vi.mock("../../src/shared/config.js", () => ({getBossmodeDir: () => sandbox}));
const owner = "mem_owner";
const other = "mem_other";
const input = () => ({memberId: owner, scopeId: "room:r", kind: "generic" as const, sessionMode: "new" as const,
  prompt: "work", snapshot: {model: "provider/model", credentialId: "account-a", thinkingLevel: "high"}});
function sessionFile(scope = "rooms/r", member = owner, filename = "session.jsonl"): string {
  const path = join(sandbox, "members", member, "sessions", "2026-09-09", scope, filename);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, '{"type":"session","id":"sdk-id"}\n');
  return path;
}
function restart(): void {
  const path = db.path;
  db.close();
  db = openDatabase(path);
  applyStorageMigrations(db, [baseStorageMigration, executionMigration]);
  bindDatabase(db);
}
beforeEach(() => {
  forcedUUID = undefined;
  sandbox = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!, "execution-"));
  mkdirSync(join(sandbox, "knowledge"));
  // Frozen historical schema on an absolute isolated path, closed before core
  // opens. No registry getter, default open, production data or SDK IO.
  const path = join(sandbox, "bossmode.db");
  createLegacyMemberStorageFixture(path);
  db = openDatabase(path);
  applyStorageMigrations(db, [baseStorageMigration, executionMigration]);
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

describe("DB session associations, unchanged SDK files", () => {
  it("stores normalized descriptors, no current.json; reopening/reset never changes SDK bytes", () => {
    const file = sessionFile();
    const bytes = readFileSync(file);
    sessions.saveCurrentSession(owner, "room:r", {runtime:"pi-sdk",sessionId:"sdk-id",sessionFile:file});
    expect(db.get("SELECT scope_id,file_reference,reference_kind FROM current_sessions")).toEqual({scope_id:"r",file_reference:"sessions/2026-09-09/rooms/r/session.jsonl",reference_kind:"member-relative"});
    expect(existsSync(join(sandbox,"members",owner,"sessions","current.json"))).toBe(false);
    restart();
    expect(sessions.getSessions("r", owner)[owner]).toEqual({runtime:"pi-sdk",sessionId:"sdk-id",sessionFile:file});
    sessions.clearCurrentSessions(owner,["room:r"]);
    expect(sessions.getCurrentSession(owner,"r")).toBeUndefined();
    expect(readFileSync(file)).toEqual(bytes);
  });
  it("keeps room/DM ownership separate, stable over rename and reuse", () => {
    for (const scope of ["r",`dm:${owner}`]) sessions.saveCurrentSession(owner,scope,{runtime:"pi-sdk",sessionId:scope});
    db.run("UPDATE members SET name='Renamed',name_key='renamed' WHERE id=?",owner);
    db.run("UPDATE members SET name='Alice',name_key='alice' WHERE id=?",other);
    expect(sessions.getCurrentSession(other,"r")).toBeUndefined();
    expect(sessions.getCurrentSession(owner,"r")?.sessionId).toBe("r");
    sessions.clearCurrentSession(owner,"r");
    expect(sessions.getCurrentSession(owner,`dm:${owner}`)?.sessionId).toBe(`dm:${owner}`);
    expect(() => sessions.saveCurrentSession(other,`dm:${owner}`,{runtime:"pi-sdk"})).toThrow(/belong/);
    expect(() => sessions.saveCurrentSession("Alice","r",{runtime:"pi-sdk"})).toThrow(/member ID/);
    expect(() => sessions.saveCurrentSession(owner,"room:missing",{runtime:"pi-sdk"})).toThrow(/scope_not_found/);
  });
  it("rejects wrong-scope, symlink, escaped, and missing references", () => {
    const file = sessionFile();
    expect(() => sessions.saveCurrentSession(owner,`dm:${owner}`,{runtime:"pi-sdk",sessionFile:file})).toThrow(/outside/);
    expect(() => sessions.saveCurrentSession("../escape","r",{runtime:"pi-sdk",sessionFile:file})).toThrow(/Invalid member/);
    const link = join(dirname(file),"link.jsonl"); symlinkSync(file,link);
    expect(() => sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionFile:link})).toThrow(/symlink/);
    const absent = join(dirname(file),"missing.jsonl");
    sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionFile:absent}); // SDK may prepare before first append.
    expect(() => sessions.getCurrentSession(owner,"r")).toThrow(/is missing/);
    const outside = join(sandbox,"outside"); mkdirSync(outside);
    const escape = join(sandbox,"members",owner,"sessions","2026-09-10"); symlinkSync(outside,escape);
    expect(() => sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionFile:join(escape,"rooms/r/a.jsonl")})).toThrow(/escapes/);
  });
  it("imports exact timestamps and legacy SDK references without moving or mirroring history", () => {
    const file = join(sandbox,"rooms/r/pi-sessions/old.jsonl"); mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"old-sdk-bytes\n");
    const repo = new SessionRepository(db);
    repo.importAssociation({memberId:owner,scopeId:"room:r",referenceKind:"legacy-absolute",createdAt:123,updatedAt:456,
      session:{runtime:"pi-sdk",sessionId:"old-id",sessionFile:file}});
    expect(repo.get(owner,"r")).toMatchObject({createdAt:123,updatedAt:456});
    expect(sessions.getCurrentSession(owner,"r")?.sessionFile).toBe(file);
    sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionId:"old-id",sessionFile:file});
    expect(repo.get(owner,"r")).toMatchObject({referenceKind:"legacy-absolute",createdAt:123});
    expect(readFileSync(file,"utf8")).toBe("old-sdk-bytes\n");
    expect(db.all("SELECT name FROM sqlite_master WHERE name LIKE '%session%' AND type='table'")).toEqual([{name:"current_sessions"}]);
  });
  it("keeps real SDK create/open/context/fork behavior file-backed across DB reopen", async () => {
    const {SessionManager} = await import("@earendil-works/pi-coding-agent");
    const dir = sessions.mainSessionDirectory(owner,"room:r");mkdirSync(dir,{recursive:true});
    const manager=SessionManager.create(sandbox,dir);
    manager.appendMessage({role:"user",content:[{type:"text",text:"original user context"}]} as any);
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"original answer"}]} as any);
    const file=manager.getSessionFile()!;
    const bytes=readFileSync(file);
    const context=JSON.stringify(manager.buildSessionContext());
    sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionId:manager.getSessionId(),sessionFile:file});
    restart();
    const association=sessions.getCurrentSession(owner,"r")!;
    const opened=SessionManager.open(association.sessionFile!,dir,sandbox);
    expect(opened.getSessionId()).toBe(manager.getSessionId());
    expect(JSON.stringify(opened.buildSessionContext())).toBe(context);
    const dmDir=sessions.mainSessionDirectory(owner,`dm:${owner}`);mkdirSync(dmDir,{recursive:true});
    const fork=SessionManager.forkFrom(file,sandbox,dmDir);
    expect(JSON.stringify(fork.buildSessionContext())).toBe(context);
    sessions.saveCurrentSession(owner,`dm:${owner}`,{runtime:"pi-sdk",sessionId:fork.getSessionId(),sessionFile:fork.getSessionFile()});
    fork.appendMessage({role:"user",content:[{type:"text",text:"dm-only continuation"}]} as any);
    fork.appendMessage({role:"assistant",content:[{type:"text",text:"dm answer"}]} as any);
    expect(readFileSync(file)).toEqual(bytes);
    const task=background.createBackgroundTask({...input(),sessionMode:"fork",parentSessionRef:file});
    const child=SessionManager.forkFrom(file,sandbox,task.sessionDir);
    expect(JSON.stringify(child.buildSessionContext())).toBe(context);
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(join(task.sessionDir,"task.json"))).toBe(false);
    sessions.clearCurrentSession(owner,`dm:${owner}`);
    expect(existsSync(fork.getSessionFile()!)).toBe(true);
    expect(sessions.getCurrentSession(owner,"r")?.sessionId).toBe(manager.getSessionId());
  });
  it("rejects malformed pure-import archive references and non-file SDK references", () => {
    const repo=new SessionRepository(db);
    expect(() => repo.importAssociation({memberId:owner,scopeId:"r",referenceKind:"member-relative",createdAt:1,updatedAt:2,
      session:{runtime:"pi-sdk",sessionFile:"sessions/2026-09-09/rooms/other/wrong.jsonl"}})).toThrow(/owned scope/);
    const fake=join(sandbox,"members",owner,"sessions/2026-09-09/rooms/r/directory.jsonl");mkdirSync(fake,{recursive:true});
    expect(() => sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionFile:fake})).toThrow(/not a file/);
  });
  it("does not read legacy current.json on get or preserve it as a shadow", () => {
    const file=sessionFile();const legacy=join(sandbox,"members",owner,"sessions","current.json");
    writeFileSync(legacy,"broken");
    expect(sessions.getCurrentSession(owner,"r")).toBeUndefined();
    sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk"});
    expect(readFileSync(legacy,"utf8")).toBe("broken");
  });
  it("rolls back failed association writes with no file mutation or successful fallback", () => {
    const file=sessionFile();
    sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionId:"first",sessionFile:file});
    db.exec("CREATE TRIGGER reject_session BEFORE UPDATE ON current_sessions BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk",sessionId:"second",sessionFile:file})).toThrow(/injected/);
    expect(sessions.getCurrentSession(owner,"r")?.sessionId).toBe("first");
  });
});

describe("runtime checkpoints and numeric user cursor semantics", () => {
  it("normalizes fields, merges stale mounts, clears drift, and survives reopen across scopes", () => {
    runtime.markStaleMounts("room:r",owner,["mcpServers"]);
    runtime.markStaleMounts("r",owner,["mcpServers","extensions"]);
    runtime.markDriftNotified("room:r",owner,9);
    runtime.setContractFingerprint("room:r",owner,"hash",10);
    runtime.setContractFingerprint(`dm:${owner}`,owner,"dm",1);
    restart();
    expect(runtime.getRuntimeStateEntry("r",owner)).toMatchObject({contractFingerprint:"hash",contractVersion:10,staleMounts:{fields:["mcpServers","extensions"]}});
    expect(runtime.getRuntimeStateEntry("r",owner).driftNotified).toBeUndefined();
    expect(Object.keys(runtime.readRuntimeState("room:r"))).toEqual([`room:r:${owner}`]);
    runtime.clearStaleMounts("room:r",owner);
    expect(db.all("SELECT * FROM runtime_stale_fields")).toEqual([]);
    runtime.clearRuntimeStateEntry("r",owner);
    expect(runtime.getRuntimeStateEntry(`dm:${owner}`,owner).contractFingerprint).toBe("dm");
    expect(runtime.readRuntimeState("room:missing")).toEqual({});
    expect(existsSync(join(sandbox,"rooms/r/runtime-state.json"))).toBe(false);
  });
  it("imports normalized runtime records with timestamps; failure rolls back child fields", () => {
    const repo=new RuntimeRepository(db);
    repo.importEntry("r",owner,{contractFingerprint:"original",staleMounts:{since:100,fields:["one"]}},101);
    db.exec("CREATE TRIGGER reject_fields BEFORE INSERT ON runtime_stale_fields WHEN NEW.field='bad' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => repo.importEntry("r",owner,{contractFingerprint:"changed",staleMounts:{since:200,fields:["two","bad"]}},201)).toThrow(/injected/);
    expect(repo.get("r",owner)).toEqual({contractFingerprint:"original",staleMounts:{since:100,fields:["one"]}});
    expect(db.get("SELECT updated_at FROM runtime_checkpoints")).toEqual({updated_at:101});
    runtime.clearStaleMounts(`dm:${owner}`,owner);
    expect(db.all("SELECT * FROM runtime_checkpoints WHERE scope_id=?", `dm:${owner}`)).toEqual([]);
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

describe("background DB lifecycle, cancellation and restart", () => {
  it("creates only SDK directory, lists DB truth even with missing directories and forged task.json", () => {
    const a=background.createBackgroundTask(input());
    expect(existsSync(a.sessionDir)).toBe(true);
    expect(existsSync(join(a.sessionDir,"task.json"))).toBe(false);
    writeFileSync(join(a.sessionDir,"task.json"),JSON.stringify({...a,status:"done",result:"forged"}));
    expect(background.getBackgroundTask(owner,a.taskId)?.status).toBe("starting");
    rmSync(join(sandbox,"members"),{recursive:true,force:true});
    expect(background.listBackgroundTasks(owner)).toEqual([a]);
    expect(background.getBackgroundTask(other,a.taskId)).toBeNull();
    expect(background.listBackgroundTasks(other)).toEqual([]);
    expect(background.getBackgroundTask(owner,"../escape")).toBeNull();
  });
  it("preserves terminal results immutably with one commit-safe notification, concurrent repeatable waiters", async () => {
    const a=background.createBackgroundTask(input());
    const w1=background.whenTerminal(owner,a.taskId), w2=background.whenTerminal(owner,a.taskId), disposed=background.whenTerminal(owner,a.taskId);
    disposed.dispose();
    background.updateBackgroundTask(owner,a.taskId,{status:"running"});
    const done=background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"real answer"});
    expect(await Promise.all([w1.promise,w2.promise])).toEqual([done,done]);
    expect(await background.whenTerminal(owner,a.taskId).promise).toEqual(done);
    expect(() => background.updateBackgroundTask(owner,a.taskId,{status:"failed",error:"late"})).toThrow(/immutable/);
    expect(() => db.run("UPDATE background_tasks SET result='tamper' WHERE task_id=?",a.taskId)).toThrow(/immutable/);
    expect(db.all("SELECT kind,dedupe_key,payload_json FROM outbox")).toEqual([{kind:"background.terminal",dedupe_key:`background.terminal:${a.taskId}`,payload_json:JSON.stringify({taskId:a.taskId,memberId:owner,status:"done"})}]);
    restart();
    expect(background.getBackgroundTask(owner,a.taskId)).toEqual(done);
  });
  it("preserves starting cancel, completion-before-cancel allowance, and rejects invalid terminal results", () => {
    const a=background.createBackgroundTask(input());
    expect(() => background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"early"})).toThrow(/illegal/);
    background.updateBackgroundTask(owner,a.taskId,{status:"cancelling"});
    expect(() => background.updateBackgroundTask(owner,a.taskId,{status:"running"})).toThrow(/illegal/);
    expect(() => background.updateBackgroundTask(owner,a.taskId,{status:"done"})).toThrow(/result/);
    background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"completed before cancel"});
    const b=background.createBackgroundTask(input());
    background.updateBackgroundTask(owner,b.taskId,{status:"cancelling"});
    background.updateBackgroundTask(owner,b.taskId,{status:"cancelled",error:"cancelled"});
    expect(() => background.updateBackgroundTask(owner,b.taskId,{status:"done",result:"late"})).toThrow(/immutable/);
    const c=background.createBackgroundTask(input());
    expect(() => background.updateBackgroundTask(owner,c.taskId,{status:"failed"})).toThrow(/result\/error/);
    expect(() => background.updateBackgroundTask(owner,c.taskId,{status:"interrupted",error:"not live"})).toThrow(/restart/);
  });
  it("imports exact IDs/times/results/references idempotently and refuses conflicting immutable records", () => {
    const a=background.createBackgroundTask(input());
    background.updateBackgroundTask(owner,a.taskId,{status:"running"});
    const done=background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"answer"});
    const imported={...done, taskId:"bgt-00000000-0000-4000-8000-000000000000", startedAt:"2026-01-01T01:00:00.000Z",endedAt:"2026-01-01T02:00:00.000Z"};
    imported.sessionDir=join(sandbox,"members",owner,"background-tasks","2026-01-01",imported.taskId);
    imported.parentSessionRef=join(sandbox,"rooms/r/old-parent.jsonl");
    const repo=new BackgroundRepository(db);repo.importRecord(imported);repo.importRecord(imported);
    expect(repo.get(owner,imported.taskId)).toEqual(imported);
    expect(existsSync(imported.sessionDir)).toBe(false); // Pure importer does not materialize SDK files.
    expect(() => repo.importRecord({...imported,result:"changed"})).toThrow(/Conflicting/);
    expect(() => repo.importRecord({...imported,memberId:other})).toThrow(/ownership/);
  });
  it("marks all incomplete tasks interrupted once on restart, including deleted directories, never replays", () => {
    const a=background.createBackgroundTask(input());
    const b=background.createBackgroundTask({...input(),memberId:other});background.updateBackgroundTask(other,b.taskId,{status:"running"});
    const c=background.createBackgroundTask(input());background.updateBackgroundTask(owner,c.taskId,{status:"cancelling"});
    const d=background.createBackgroundTask(input());background.updateBackgroundTask(owner,d.taskId,{status:"failed",error:"already failed"});
    rmSync(join(sandbox,"members"),{recursive:true,force:true});restart();
    expect(background.sweepInterruptedBackgroundTasks()).toBe(3);
    expect(background.sweepInterruptedBackgroundTasks()).toBe(0);
    for(const task of [a,b,c]) expect(background.getBackgroundTask(task.memberId,task.taskId)).toMatchObject({status:"interrupted",error:"interrupted by service restart; not resumed"});
    expect(background.getBackgroundTask(owner,d.taskId)?.error).toBe("already failed");
    expect(existsSync(join(sandbox,"members"))).toBe(false);
  });
  it("rolls back terminal/result and notification together on outbox failure and rejects unsaved waiters", async () => {
    const a=background.createBackgroundTask(input());background.updateBackgroundTask(owner,a.taskId,{status:"running"});
    const wait=background.whenTerminal(owner,a.taskId);
    db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"not saved"})).toThrow(/injected/);
    expect(background.getBackgroundTask(owner,a.taskId)).toMatchObject({status:"running",result:null,endedAt:null});
    expect(db.all("SELECT * FROM outbox")).toEqual([]);
    const rejection=expect(wait.promise).rejects.toThrow(/unsaved diagnosis/);
    background.failBackgroundTaskUnsaved(owner,a.taskId,"disk full");
    await rejection;
    expect(background.getBackgroundTask(owner,a.taskId)?.status).toBe("running");
  });
  it("does not notify waiters of a nested transaction subsequently rolled back", async () => {
    const a=background.createBackgroundTask(input());background.updateBackgroundTask(owner,a.taskId,{status:"running"});
    const wait=background.whenTerminal(owner,a.taskId);let settled=false;void wait.promise.then(()=>settled=true);
    expect(() => db.transaction(() => {background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"rollback"});throw Error("rollback");})).toThrow(/rollback/);
    await Promise.resolve();await Promise.resolve();
    expect(settled).toBe(false);expect(background.getBackgroundTask(owner,a.taskId)?.status).toBe("running");
    background.updateBackgroundTask(owner,a.taskId,{status:"done",result:"committed"});
    expect((await wait.promise).result).toBe("committed");
  });
  it("aborts the entire startup sweep when a record cannot transition", () => {
    const a=background.createBackgroundTask(input()),b=background.createBackgroundTask(input());
    db.exec("CREATE TRIGGER reject_restart BEFORE UPDATE ON background_tasks WHEN NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'restart failure'); END");
    expect(() => background.sweepInterruptedBackgroundTasks()).toThrow(/restart failure/);
    expect(background.getBackgroundTask(owner,a.taskId)?.status).toBe("starting");
    expect(background.getBackgroundTask(owner,b.taskId)?.status).toBe("starting");
  });
  it("propagates unavailable storage with no JSON fallback and settles waiters as errors", async () => {
    const a=background.createBackgroundTask(input());const w=background.whenTerminal(owner,a.taskId);
    db.close();
    expect(() => background.listBackgroundTasks(owner)).toThrow(/not initialized/);
    expect(() => sessions.saveCurrentSession(owner,"r",{runtime:"pi-sdk"})).toThrow(/not initialized/);
    const reject=expect(w.promise).rejects.toThrow(/unsaved/);background.failBackgroundTaskUnsaved(owner,a.taskId,"closed database");await reject;
    expect(() => getDatabase()).toThrow(/not initialized/);
  });
  it("refuses to reuse an orphan SDK preparation directory", () => {
    forcedUUID="11111111-1111-4111-8111-111111111111";
    const dir=join(sandbox,"members",owner,"background-tasks",new Date().toISOString().slice(0,10),`bgt-${forcedUUID}`);
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"orphan.jsonl"),"orphan SDK bytes");
    expect(() => background.createBackgroundTask(input())).toThrow(/EEXIST/);
    expect(background.listBackgroundTasks(owner)).toEqual([]);
    expect(readFileSync(join(dir,"orphan.jsonl"),"utf8")).toBe("orphan SDK bytes");
  });
  it("propagates SQLite read-only/full failures without successful terminal writes", () => {
    const task=background.createBackgroundTask(input());background.updateBackgroundTask(owner,task.taskId,{status:"running"});
    db.exec("PRAGMA query_only=ON");
    expect(() => background.updateBackgroundTask(owner,task.taskId,{status:"done",result:"not saved"})).toThrow(/readonly/);
    expect(() => cursors.setUserReadCursor("room:r",{seq:5})).toThrow(/readonly/);
    db.exec("PRAGMA query_only=OFF; PRAGMA max_page_count=1");
    expect(() => background.updateBackgroundTask(owner,task.taskId,{status:"done",result:"x".repeat(1024*1024)})).toThrow(/full/);
    expect(background.getBackgroundTask(owner,task.taskId)).toMatchObject({status:"running",result:null,endedAt:null});
    expect(db.all("SELECT * FROM outbox")).toEqual([]);
    expect(existsSync(join(task.sessionDir,"task.json"))).toBe(false);
  });
  it("rejects new-task invalid ownership before preparing filesystem assets", () => {
    expect(() => background.createBackgroundTask({...input(),memberId:"../outside"})).toThrow(/member ID/);
    expect(() => background.createBackgroundTask({...input(),scopeId:`room:dm:${owner}`})).toThrow(/Invalid execution scope/);
    expect(() => background.createBackgroundTask({...input(),scopeId:`dm:${other}`})).toThrow(/belong/);
    expect(existsSync(join(sandbox,"members",owner,"background-tasks"))).toBe(false);
    symlinkSync(join(sandbox,"knowledge"),join(sandbox,"members",owner,"background-tasks"));
    expect(() => background.createBackgroundTask(input())).toThrow(/escapes/);
    expect(background.listBackgroundTasks(owner)).toEqual([]);
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
