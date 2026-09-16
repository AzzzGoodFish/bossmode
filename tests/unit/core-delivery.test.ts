import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
import { baseStorageMigration } from "../../src/data/base-schema.js";
import { messagesMigration } from "../../src/data/schema/messages.js";
import { runtimeInputsMigration } from "../../src/data/schema/runtime-inputs.js";
import { deliveryMigration } from "../../src/data/schema/delivery.js";
import { executionMigration } from "../../src/data/schema/execution.js";
import { ExecutionAttemptRepository } from "../../src/data/repositories/execution-attempt-repository.js";
import { appendMessageInTransaction } from "../../src/data/repositories/message-repository.js";
import { acceptCapturedDelivery, DeliveryRepository, type CapturedMessage, type DeliveryKey } from "../../src/data/repositories/delivery-repository.js";
import { ReplyObligationRepository } from "../../src/data/repositories/reply-obligation-repository.js";
import { InputQueueRepository, type QueuedInput } from "../../src/data/repositories/input-queue-repository.js";

let db: Database;
let root: string;
let deliveries: DeliveryRepository;
let replies: ReplyObligationRepository;
let queue: InputQueueRepository;
const oldActor = { actorKey: "scope-local-123", memberId: null };
const modernActor = { actorKey: "mem-modern", memberId: "mem-modern" };
const migrations = [baseStorageMigration, messagesMigration, deliveryMigration, runtimeInputsMigration];
function repos() {
  deliveries = new DeliveryRepository(db);
  replies = new ReplyObligationRepository(db);
  queue = new InputQueueRepository(db);
}
function capture(messageId = "msg-1", scopeId = "r"): CapturedMessage {
  return { scopeId, messageId, snapshot: {
    message: { id: messageId, sender: "user", content: "@all !Old Name original", mentions: ["all"], attachments: [{path:"original.txt"}] },
    context: { banner: "original reply context", nested: [1, true, null] },
    origin: "user", messageType: "chat", senderActorKey: null, senderMemberId: null,
    targets: { ordinary: scopeId.startsWith("dm:") ? [] : [oldActor, modernActor], dm: scopeId.startsWith("dm:") ? [oldActor] : [] },
    needResponse: null,
  } };
}
function key(c = capture(), actorKey = oldActor.actorKey, kind: DeliveryKey["deliveryKind"] = c.scopeId.startsWith("dm:") ? "dm" : "ordinary"): DeliveryKey {
  return { scopeId: c.scopeId, messageId: c.messageId, targetActorKey: actorKey, deliveryKind: kind };
}
function accept(c = capture(), actorKey = oldActor.actorKey, kind?: DeliveryKey["deliveryKind"]) {
  return acceptCapturedDelivery(db, { ...key(c, actorKey, kind), snapshot: c.snapshot }, 10);
}
function enqueue(c = capture()): QueuedInput {
  accept(c);
  return queue.enqueue({ ...key(c), payload: { prompt: "captured input", context: c.snapshot.context }, trigger: "mention" }, 11).input;
}
function ownReply(id: string, scopeId = "r", actor = oldActor): CapturedMessage {
  const c = capture(id, scopeId);
  Object.assign(c.snapshot, { origin: "member", senderActorKey: actor.actorKey, senderMemberId: actor.memberId });
  c.snapshot.message.sender = "Old Name";
  c.snapshot.targets = { ordinary: [], dm: [] };
  return c;
}
function restart() {
  const path = db.path;
  db.close();
  db = openDatabase(path);
  applyStorageMigrations(db, migrations);
  repos();
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!, "delivery-"));
  db = openDatabase(join(root, "core.db"));
  applyStorageMigrations(db, migrations);
  db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r'),('topic:t','topic','r')");
  db.run("INSERT INTO scopes(id,kind,member_id) VALUES('dm:scope-local-123','dm','scope-local-123')");
  repos();
});
afterEach(() => { db.close(); rmSync(root, {recursive:true, force:true}); });

describe("captured routing acceptance", () => {
  it("has no lazy initialization and needs only explicit base/C/J migrations, not members", () => {
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name='members'")).toBeUndefined();
    accept();
    const bare = openDatabase(join(root, "bare.db"));
    try { expect(() => new DeliveryRepository(bare).captureMessage(capture(), 1)).toThrow(/no such table/); }
    finally { bare.close(); }
  });
  it("accepts the same stable key once across reopen, preserving original snapshot and timestamp", () => {
    const c = capture();
    const first = accept(c);
    expect(first.accepted).toBe(true);
    expect(first.delivery.targetMemberId).toBeNull();
    const read = deliveries.getCapture("r", "msg-1")!;
    read.snapshot.message.content = "client mutation";
    restart();
    expect(acceptCapturedDelivery(db, { ...key(c), snapshot: c.snapshot }, 900)).toEqual({ accepted: false, delivery: first.delivery });
    expect(deliveries.getCapture("r", "msg-1")).toEqual(c);
    expect(db.get("SELECT COUNT(*) AS n FROM captured_deliveries")).toEqual({n:1});
  });
  it("accepts equivalent JSON key ordering, but rejects changed original identity/context/targets", () => {
    const c = capture(); accept(c);
    const reordered = structuredClone(c);
    reordered.snapshot.context = { nested: [1,true,null], banner: "original reply context" };
    expect(accept(reordered).accepted).toBe(false);
    for (const change of [
      (s: CapturedMessage["snapshot"]) => { s.message.content = "changed"; },
      (s: CapturedMessage["snapshot"]) => { s.context = {}; },
      (s: CapturedMessage["snapshot"]) => { s.targets.ordinary[0].memberId = "invented"; },
      (s: CapturedMessage["snapshot"]) => { s.senderMemberId = "other"; s.senderActorKey = "other"; },
      (s: CapturedMessage["snapshot"]) => { s.needResponse = []; },
    ]) {
      const changed = structuredClone(c); change(changed.snapshot);
      expect(() => accept(changed)).toThrow(/Conflicting captured/);
    }
    expect(() => acceptCapturedDelivery(db, { ...key(c), snapshot: {...c.snapshot, message: {id:"other"}} }, 10)).toThrow(/ID mismatch/);
  });
  it("never resolves labels, @all or current roster; supplied empty expansion stays empty", () => {
    const c = capture();
    c.snapshot.targets.ordinary = [];
    expect(deliveries.captureMessage(c, 1).inserted).toBe(true);
    expect(() => accept(c)).toThrow(/not a captured target/);
    expect(replies.openForCapturedMessage(c, 2)).toEqual({opened:0});
    expect(db.all("SELECT * FROM captured_deliveries")).toEqual([]);
    const explicit = capture("expanded");
    expect(accept(explicit).accepted).toBe(true);
    expect(accept(explicit, modernActor.actorKey).accepted).toBe(true);
    expect(() => accept(explicit, "New Roster Member")).toThrow(/not a captured target/);
  });
  it("keeps rename/name reuse and removed historical actors attached to captured IDs", () => {
    // An independent roster is intentionally not a dependency of J.
    db.exec("CREATE TABLE fixture_roster(id TEXT PRIMARY KEY,name TEXT)");
    db.run("INSERT INTO fixture_roster VALUES(?,'Old Name'),(?,'Other')", oldActor.actorKey, modernActor.actorKey);
    const c = capture(); accept(c); replies.openForCapturedMessage(c, 1);
    db.run("UPDATE fixture_roster SET name='Renamed' WHERE id=?", oldActor.actorKey);
    db.run("UPDATE fixture_roster SET name='Old Name' WHERE id=?", modernActor.actorKey);
    db.run("DELETE FROM fixture_roster WHERE id=?", oldActor.actorKey);
    restart();
    expect(accept(c).accepted).toBe(false);
    expect(replies.listPending("r", oldActor.actorKey)[0].memberId).toBeNull();
    expect(deliveries.getCapture("r", c.messageId)?.snapshot.message.content).toContain("Old Name");
    expect(() => accept(c, "Old Name")).toThrow(/not a captured target/);
  });
  it("keeps ordinary, DM and room/topic scope receipts distinct", () => {
    const c = capture();
    expect(accept(c).accepted).toBe(true);
    expect(accept(c).accepted).toBe(false);
    expect(accept(capture("msg-1", "topic:t")).accepted).toBe(true);
    expect(accept(capture("msg-1", "dm:scope-local-123")).accepted).toBe(true);
    const bad = capture("wrong-kind"); bad.snapshot.targets.dm = [oldActor];
    expect(() => accept(bad, oldActor.actorKey, "dm")).toThrow(/kind.*scope/);
    expect(deliveries.getCapture("r", "wrong-kind")).toBeUndefined();
  });
  it("rejects unresolved/invented IDs, missing arrays, duplicates, non-JSON payloads", () => {
    const cases = [
      (c: CapturedMessage) => { c.snapshot.targets.ordinary[0].actorKey = ""; },
      (c: CapturedMessage) => { c.snapshot.targets.ordinary[0].memberId = undefined as any; },
      (c: CapturedMessage) => { (c.snapshot.targets as any).dm = undefined; },
      (c: CapturedMessage) => { c.snapshot.targets.ordinary.push(oldActor); },
      (c: CapturedMessage) => { c.snapshot.context = {fn: (() => {}) as any}; },
      (c: CapturedMessage) => { c.snapshot.context = {bad: NaN}; },
      (c: CapturedMessage) => { c.snapshot.context = new Date() as any; },
      (c: CapturedMessage) => { c.snapshot.context = undefined as any; },
    ];
    for (const modify of cases) {
      const c = structuredClone(capture()); modify(c);
      expect(() => accept(c)).toThrow();
    }
    expect(db.all("SELECT * FROM delivery_captures")).toEqual([]);
  });
  it("persists original outbox snapshot/dedup after live C message deletion and mutable card changes", () => {
    let c: CapturedMessage;
    db.transaction(tx => {
      const message = appendMessageInTransaction(tx, "r", { sender:"user", content:"original", mentions:["all"] });
      c = capture(message.id);
      c.snapshot.message = JSON.parse(JSON.stringify(message));
      new DeliveryRepository(tx).captureMessage(c, 1);
      new ReplyObligationRepository(tx).openForCapturedMessage(c, 1);
    });
    db.run("UPDATE messages SET content='patched' WHERE scope_id='r'");
    db.run("DELETE FROM messages WHERE scope_id='r'");
    expect(db.get<{payload_json:string}>("SELECT payload_json FROM outbox WHERE kind='message'")!.payload_json).toContain("original");
    restart();
    expect(accept(c!).accepted).toBe(true);
    expect(accept(c!).accepted).toBe(false);
    expect(deliveries.getCapture("r", c!.messageId)?.snapshot.message.content).toBe("original");
    expect(replies.listPending("r", oldActor.actorKey)).toHaveLength(1);
    expect(() => db.run("DELETE FROM scopes WHERE id='r'")).toThrow(/FOREIGN KEY/);
  });
});

describe("per-message reply obligations", () => {
  it("opens user-origin debts once; explicit lists only debt supplied delivered IDs", () => {
    const c = capture();
    expect(replies.openForCapturedMessage(c, 1)).toEqual({opened:2});
    expect(replies.openForCapturedMessage(c, 2)).toEqual({opened:0});
    const explicit = ownReply("explicit", "r", {actorKey:"sender",memberId:"sender"});
    explicit.snapshot.targets.ordinary = [oldActor, modernActor];
    explicit.snapshot.needResponse = [oldActor, {actorKey:"not-mentioned",memberId:null}];
    expect(replies.openForCapturedMessage(explicit, 3)).toEqual({opened:1});
    expect(replies.listPending("r", "not-mentioned")).toEqual([]);
    expect(replies.listPending("r", oldActor.actorKey).map(x => x.reason)).toEqual(["user","explicit"]);
  });
  it("user-origin opens all delivered debts unless explicitly FYI, even with a nonempty need-response list", () => {
    const c = capture(); c.snapshot.needResponse = [oldActor];
    expect(replies.openForCapturedMessage(c,1)).toEqual({opened:2});
    expect(replies.listPending("r",modernActor.actorKey)[0].reason).toBe("user");
  });
  it.each(["chat", "task_event", "knowledge_event", "notification"] as const)("FYI %s never opens debt", type => {
    const c = capture(); c.snapshot.messageType = type; c.snapshot.needResponse = [];
    expect(replies.openForCapturedMessage(c, 1)).toEqual({opened:0});
    c.messageId = "explicit"; c.snapshot.message.id = "explicit"; c.snapshot.needResponse = [oldActor];
    expect(replies.openForCapturedMessage(c, 1).opened).toBe(type === "chat" ? 2 : 0);
  });
  it("member FYI and self-targets do not open debt", () => {
    const c = ownReply("fyi"); c.snapshot.targets.ordinary = [oldActor, modernActor];
    expect(replies.openForCapturedMessage(c, 1)).toEqual({opened:0});
    const explicit = structuredClone(c); explicit.messageId = "self"; explicit.snapshot.message.id = "self";
    explicit.snapshot.needResponse = [oldActor, modernActor];
    expect(replies.openForCapturedMessage(explicit, 1)).toEqual({opened:1});
    expect(replies.listPending("r", oldActor.actorKey)).toEqual([]);
  });
  it("settles explicit stable reply target, then explicit all-pending policy without name guessing", () => {
    for (const id of ["a","b"]) replies.openForCapturedMessage(capture(id), 1);
    replies.openForCapturedMessage(capture("a", "topic:t"), 1);
    const reply = ownReply("reply"); deliveries.captureMessage(reply, 2);
    expect(() => replies.settleOwnChat({scopeId:"r",replyMessageId:"reply",actorKey:"Old Name",selection:{mode:"all-pending"}}, 2)).toThrow(/own chat sender/);
    expect(replies.settleOwnChat({scopeId:"r",replyMessageId:"reply",actorKey:oldActor.actorKey,selection:{mode:"reply-target",messageId:"a"}}, 2)).toEqual({applied:true,settled:1});
    expect(replies.listPending("r", oldActor.actorKey).map(x => x.messageId)).toEqual(["b"]);
    expect(replies.listPending("r", modernActor.actorKey)).toHaveLength(2);
    expect(replies.listPending("topic:t", oldActor.actorKey)).toHaveLength(1);
    const next = ownReply("reply2"); deliveries.captureMessage(next, 3);
    expect(replies.settleOwnChat({scopeId:"r",replyMessageId:"reply2",actorKey:oldActor.actorKey,selection:{mode:"all-pending"}}, 3)).toEqual({applied:true,settled:1});
    expect(replies.openForCapturedMessage(capture("a"), 4)).toEqual({opened:0});
  });
  it("settlement replay never clears later debts, even if the original cleared zero", () => {
    deliveries.captureMessage(ownReply("reply"), 1);
    const settlement = {scopeId:"r",replyMessageId:"reply",actorKey:oldActor.actorKey,selection:{mode:"all-pending" as const}};
    expect(replies.settleOwnChat(settlement, 1)).toEqual({applied:true,settled:0});
    replies.openForCapturedMessage(capture(), 2);
    restart();
    expect(replies.settleOwnChat(settlement, 3)).toEqual({applied:false,settled:0});
    expect(replies.listPending("r", oldActor.actorKey)).toHaveLength(1);
    expect(() => replies.settleOwnChat({...settlement,selection:{mode:"reply-target",messageId:"msg-1"}}, 3)).toThrow(/Conflicting reply settlement/);
  });
  it.each(["task_event", "knowledge_event", "notification"] as const)("%s cannot settle own chat debt", type => {
    replies.openForCapturedMessage(capture(), 1);
    const c = ownReply("reply"); c.snapshot.messageType = type; deliveries.captureMessage(c, 2);
    expect(() => replies.settleOwnChat({scopeId:"r",replyMessageId:"reply",actorKey:oldActor.actorKey,selection:{mode:"all-pending"}}, 2)).toThrow(/own chat sender/);
    expect(replies.listPending("r", oldActor.actorKey)).toHaveLength(1);
  });
});

describe("durable queued input state", () => {
  it("requires acceptance and enqueues exactly once with immutable JSON payload/trigger", () => {
    expect(() => queue.enqueue({...key(),payload:{prompt:"x"},trigger:"mention"}, 1)).toThrow(/requires captured/);
    const item = enqueue();
    const repeated = queue.enqueue({...key(),payload:{context:capture().snapshot.context,prompt:"captured input"},trigger:"mention"}, 99);
    expect(repeated).toEqual({enqueued:false,input:item});
    expect(() => queue.enqueue({...key(),payload:{prompt:"changed"},trigger:"mention"}, 99)).toThrow(/Conflicting queued/);
    expect(() => queue.enqueue({...key(),payload:item.payload,trigger:"system"}, 99)).toThrow(/Conflicting queued/);
    expect(queue.listPending()).toEqual([item]);
    expect(item.status).toBe("pending");
    expect(item.executionAttemptId).toBeNull();
  });
  it("conditionally dispatches once and settles only with owner/token, never from pending", () => {
    const item = enqueue();
    const result = {outcome:"completed" as const,result:{ack:"verified"}};
    expect(queue.settle(item, "dispatch-a", result, 12)).toBe(false);
    expect(queue.beginDispatch({...item,targetActorKey:modernActor.actorKey}, {token:"dispatch-a",executionAttemptId:null}, 12)).toBe(false);
    expect(queue.beginDispatch(item, {token:"dispatch-a",executionAttemptId:"attempt-a"}, 12)).toBe(true);
    expect(queue.beginDispatch(item, {token:"dispatch-b",executionAttemptId:null}, 13)).toBe(false);
    expect(queue.settle(item, "wrong", result, 13)).toBe(false);
    expect(queue.listPending()).toEqual([]);
    expect(queue.settle(item, "dispatch-a", result, 14)).toBe(true);
    expect(queue.settle(item, "dispatch-a", {outcome:"failed",result:null}, 15)).toBe(false);
    expect(queue.get(item)).toMatchObject({status:"settled",executionAttemptId:"attempt-a",outcome:"completed",result:{ack:"verified"}});
    expect(enqueue().status).toBe("settled");
    expect(queue.beginDispatch(item,{token:"retry",executionAttemptId:null}, 16)).toBe(false);
  });
  it("interrupts safe pending vs dispatched unknown differently and refuses late results", () => {
    const pending = enqueue(capture("pending"));
    const dispatched = enqueue(capture("dispatched"));
    expect(queue.interrupt(pending,{status:"pending"},"cancelled before dispatch", 12)).toBe(true);
    expect(queue.beginDispatch(dispatched,{token:"dispatch",executionAttemptId:null}, 12)).toBe(true);
    expect(queue.interrupt(dispatched,{status:"pending"},"stale", 13)).toBe(false);
    expect(queue.interrupt(dispatched,{status:"dispatched",token:"wrong"},"stale", 13)).toBe(false);
    expect(queue.interrupt(dispatched,{status:"dispatched",token:"dispatch"},"interruption requested; completion unknown", 13)).toBe(true);
    expect(queue.get(pending)?.status).toBe("interrupted");
    expect(queue.get(dispatched)?.status).toBe("uncertain");
    expect(queue.settle(dispatched,"dispatch",{outcome:"completed",result:null}, 14)).toBe(false);
  });
  it("startup preserves safe pending, marks dispatched uncertain, leaves terminal rows unchanged", () => {
    const pending = enqueue(capture("pending"));
    const dispatched = enqueue(capture("dispatched"));
    const terminal = enqueue(capture("terminal"));
    queue.beginDispatch(dispatched,{token:"d",executionAttemptId:null}, 12);
    queue.interrupt(terminal,{status:"pending"},"cancelled",12);
    const beforeTerminal = queue.get(terminal);
    restart();
    expect(queue.recoverStartup(20)).toEqual({uncertain:1});
    expect(queue.recoverStartup(21)).toEqual({uncertain:0});
    expect(queue.get(pending)).toEqual(pending);
    expect(queue.get(dispatched)).toMatchObject({status:"uncertain",dispatchToken:"d",endedAt:20});
    expect(queue.get(terminal)).toEqual(beforeTerminal);
    expect(queue.listPending()).toEqual([pending]);
  });
  it("routing acceptance/queue settlement do not imply a chat reply or clear debt", () => {
    replies.openForCapturedMessage(capture(),1);
    const item = enqueue();
    expect(replies.listPending("r",oldActor.actorKey)).toHaveLength(1);
    queue.beginDispatch(item,{token:"d",executionAttemptId:null},12);
    queue.settle(item,"d",{outcome:"completed",result:{providerAcknowledged:true}},13);
    expect(replies.listPending("r",oldActor.actorKey)).toHaveLength(1);
  });
  it("parent can compose D attempt accounting atomically without a provider or SDK call", () => {
    // Explicit test-only owner fixture. J itself works with no members table.
    db.exec("CREATE TABLE members(id TEXT PRIMARY KEY)");
    db.run("INSERT INTO members VALUES(?)",modernActor.memberId);
    applyStorageMigrations(db,[...migrations,executionMigration]);
    const c = capture();
    accept(c,modernActor.actorKey);
    const item = queue.enqueue({...key(c,modernActor.actorKey),payload:{prompt:"test"},trigger:"mention"},1).input;
    const begin = (tx: Database, fail: boolean) => {
      const q = new InputQueueRepository(tx);
      if (!q.beginDispatch(item,{token:"dispatch",executionAttemptId:"attempt"},2)) throw Error("Not pending");
      const attempts = new ExecutionAttemptRepository(tx);
      attempts.prepare({id:"attempt",memberId:modernActor.memberId!,scopeId:"r",operation:"input",externalReference:`queued-input:${item.id}`,startedAt:2});
      attempts.markDispatched("attempt",modernActor.memberId!,2);
      if (fail) throw Error("rollback");
    };
    expect(() => db.transaction(tx => begin(tx,true))).toThrow("rollback");
    expect(queue.get(item)?.status).toBe("pending");
    expect(new ExecutionAttemptRepository(db).get("attempt",modernActor.memberId!)).toBeUndefined();
    db.transaction(tx => begin(tx,false));
    db.transaction(tx => {
      if (!new InputQueueRepository(tx).settle(item,"dispatch",{outcome:"completed",result:null},3)) throw Error("Not dispatched");
      new ExecutionAttemptRepository(tx).acknowledge("attempt",modernActor.memberId!,3);
    });
    expect(queue.get(item)?.status).toBe("settled");
    expect(new ExecutionAttemptRepository(db).get("attempt",modernActor.memberId!)?.status).toBe("acknowledged");
  });
  it("lists safe pending by indexed keyset and actor/scope", () => {
    const a = enqueue(capture("a")); const b = enqueue(capture("b")); const t = enqueue(capture("t","topic:t"));
    expect(queue.listPending({limit:1})).toEqual([a]);
    expect(queue.listPending({afterId:a.id,actor:{scopeId:"r",targetActorKey:oldActor.actorKey}})).toEqual([b]);
    expect(queue.listPending({actor:{scopeId:"topic:t",targetActorKey:oldActor.actorKey}})).toEqual([t]);
    expect(() => queue.listPending({limit:0})).toThrow(/Invalid/);
    const plan = db.all<{detail:string}>("EXPLAIN QUERY PLAN SELECT id FROM queued_inputs WHERE scope_id='r' AND target_actor_key=? AND status='pending' AND id>0 ORDER BY id LIMIT 100", oldActor.actorKey);
    expect(plan.some(x => x.detail.includes("queued_inputs_actor_pending"))).toBe(true);
  });
});

describe("common transactions and failure boundaries", () => {
  it("message/capture/debt/acceptance/queue and commit-only callbacks roll back together", () => {
    const callback = vi.fn();
    expect(() => db.transaction(tx => {
      const message = appendMessageInTransaction(tx, "r", {sender:"user",content:"input",mentions:[]});
      const c = capture(message.id); c.snapshot.message = JSON.parse(JSON.stringify(message));
      new ReplyObligationRepository(tx).openForCapturedMessage(c,1);
      expect(acceptCapturedDelivery(tx,{...key(c),snapshot:c.snapshot},1).accepted).toBe(true);
      new InputQueueRepository(tx).enqueue({...key(c),payload:{prompt:"input"},trigger:"mention"},1);
      tx.afterCommit(callback);
      throw new Error("outer rollback");
    })).toThrow("outer rollback");
    for (const table of ["messages","outbox","delivery_captures","captured_deliveries","reply_obligations","queued_inputs"]) expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(callback).not.toHaveBeenCalled();
    db.transaction(tx => {
      const c = capture();
      const first = acceptCapturedDelivery(tx,{...key(c),snapshot:c.snapshot},1);
      if (first.accepted) {
        new InputQueueRepository(tx).enqueue({...key(c),payload:{prompt:"input"},trigger:"mention"},1);
        tx.afterCommit(callback);
      }
      expect(callback).not.toHaveBeenCalled();
    });
    db.transaction(tx => {
      const c = capture();
      if (acceptCapturedDelivery(tx,{...key(c),snapshot:c.snapshot},2).accepted) tx.afterCommit(callback);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("nested savepoint failure and actual COMMIT failure discard all provisional acceptance", () => {
    db.transaction(tx => {
      expect(() => tx.transaction(inner => { acceptCapturedDelivery(inner,{...key(),snapshot:capture().snapshot},1); throw Error("nested"); })).toThrow("nested");
      expect(new DeliveryRepository(tx).getCapture("r","msg-1")).toBeUndefined();
    });
    db.exec("CREATE TABLE deferred_probe(scope_id TEXT REFERENCES scopes(id) DEFERRABLE INITIALLY DEFERRED)");
    const callback = vi.fn();
    expect(() => db.transaction(tx => {
      acceptCapturedDelivery(tx,{...key(),snapshot:capture().snapshot},1);
      tx.afterCommit(callback);
      tx.run("INSERT INTO deferred_probe VALUES('missing')");
    })).toThrow(/FOREIGN KEY/);
    expect(callback).not.toHaveBeenCalled();
    expect(accept().accepted).toBe(true);
  });
  it("failed queue insert cannot leave acceptance when parent composes them", () => {
    db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON queued_inputs BEGIN SELECT RAISE(ABORT,'injected queue failure'); END");
    expect(() => db.transaction(tx => {
      const c = capture();
      acceptCapturedDelivery(tx,{...key(c),snapshot:c.snapshot},1);
      new InputQueueRepository(tx).enqueue({...key(c),payload:null,trigger:"mention"},1);
    })).toThrow("injected queue failure");
    expect(deliveries.getDelivery(key())).toBeUndefined();
    db.exec("DROP TRIGGER fail_queue");
    expect(enqueue().status).toBe("pending");
  });
  it("reply settlement receipt failure and enclosing rollback preserve pending debts", () => {
    replies.openForCapturedMessage(capture(),1);
    deliveries.captureMessage(ownReply("reply"),2);
    const settlement = {scopeId:"r",replyMessageId:"reply",actorKey:oldActor.actorKey,selection:{mode:"all-pending" as const}};
    db.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON reply_settlements BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    expect(() => replies.settleOwnChat(settlement,2)).toThrow("receipt failure");
    expect(replies.listPending("r",oldActor.actorKey)).toHaveLength(1);
    db.exec("DROP TRIGGER fail_settlement");
    expect(() => db.transaction(tx => { new ReplyObligationRepository(tx).settleOwnChat(settlement,2); throw Error("rollback"); })).toThrow("rollback");
    expect(replies.listPending("r",oldActor.actorKey)).toHaveLength(1);
    expect(replies.settleOwnChat(settlement,2)).toEqual({applied:true,settled:1});
  });
  it("real SQLite read-only failure propagates without invented success or changed records", () => {
    const item = enqueue();
    replies.openForCapturedMessage(capture(),1);
    deliveries.captureMessage(ownReply("reply"),2);
    db.exec("PRAGMA query_only=ON");
    expect(() => accept(capture("new"))).toThrow(/readonly/);
    expect(() => replies.openForCapturedMessage(capture("new"),1)).toThrow(/readonly/);
    expect(() => replies.settleOwnChat({scopeId:"r",replyMessageId:"reply",actorKey:oldActor.actorKey,selection:{mode:"all-pending"}},2)).toThrow(/readonly/);
    expect(() => queue.beginDispatch(item,{token:"d",executionAttemptId:null},2)).toThrow(/readonly/);
    db.exec("PRAGMA query_only=OFF");
    expect(queue.get(item)?.status).toBe("pending");
    expect(replies.listPending("r",oldActor.actorKey)).toHaveLength(1);
    expect(deliveries.getCapture("r","new")).toBeUndefined();
    expect(queue.beginDispatch(item,{token:"d",executionAttemptId:null},2)).toBe(true);
    db.exec("PRAGMA query_only=ON");
    expect(() => queue.recoverStartup(3)).toThrow(/readonly/);
    expect(() => queue.settle(item,"d",{outcome:"completed",result:null},3)).toThrow(/readonly/);
    db.exec("PRAGMA query_only=OFF");
    expect(queue.get(item)?.status).toBe("dispatched");
  });
  it("startup and dispatch writes compose with outer rollback; SQL guards immutable facts", () => {
    const item = enqueue();
    expect(() => db.transaction(tx => { new InputQueueRepository(tx).beginDispatch(item,{token:"d",executionAttemptId:null},2); throw Error("rollback"); })).toThrow("rollback");
    expect(queue.get(item)?.status).toBe("pending");
    queue.beginDispatch(item,{token:"d",executionAttemptId:null},2);
    expect(() => db.transaction(tx => { new InputQueueRepository(tx).recoverStartup(3); throw Error("rollback"); })).toThrow("rollback");
    expect(queue.get(item)?.status).toBe("dispatched");
    expect(() => db.run("UPDATE delivery_captures SET snapshot_json='{}'")).toThrow(/immutable/);
    expect(() => db.run("UPDATE captured_deliveries SET target_member_id='new-owner'")).toThrow(/immutable/);
    expect(() => db.run("UPDATE queued_inputs SET payload_json='{}'")).toThrow(/Invalid queued/);
    expect(() => db.run("UPDATE queued_inputs SET status='pending',dispatch_token=NULL,dispatched_at=NULL")).toThrow(/Invalid queued/);
  });
});
