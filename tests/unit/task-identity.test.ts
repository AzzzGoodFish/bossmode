import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import type { Task } from "../../src/shared/types.js";

const { routes, events } = vi.hoisted(() => ({
  routes: new Map<string, (...args: any[]) => Promise<void>>(),
  events: vi.fn(),
}));
let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;
vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => mkdirSync(dir, { recursive: true }),
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: {} }),
}));
vi.mock("../../src/api/index.js", () => ({
  addRoute: (method: string, path: string, handler: any) => routes.set(`${method} ${path}`, handler),
  parseBody: async (req: any) => req.body,
  sendJson: (res: any, status: number, body: unknown) => Object.assign(res, { status, body }),
}));
vi.mock("../../src/communication/ws.js", () => ({ broadcastToRoom: vi.fn() }));

async function request(method: string, route: string, query = "", taskId?: string, body?: unknown) {
  const res: any = {};
  await routes.get(`${method} ${route}`)!({ url: `http://localhost/${query}`, body }, res, { id: "identity-room", taskId });
  expect(res.status).toBe(200);
  return res.body;
}
const roomRoute = "/api/rooms/:id/tasks";
const detailRoute = `${roomRoute}/:taskId`;

beforeEach(async () => {
  vi.resetModules();routes.clear();events.mockClear();
  const {coreFixture}=await import("../helpers/core-fixture.js");fixture=coreFixture();dir=fixture.root;
});
afterEach(async()=>{await new Promise(resolve=>setImmediate(resolve));fixture.close();});

describe("current task identities (authoritative SQL)", () => {
  it("projects renames, resolves ID filters before pagination, and leaves snapshots and history unchanged", async () => {
    const registry = await import("../../src/workspace/member-registry.js");
    const importMember = (id: string, name: string) => registry.importMemberRecord({
      id, name, agentTemplate: "general", global: {}, unifiedModel: true,
      unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1,
    });
    importMember("mem_alice", "alice");
    importMember("mem_bob", "bob");
    const room = { id: "identity-room", name: "Identity", members: ["alice", "bob"], globalMemberIds: ["mem_alice", "mem_bob"], createdAt: 1 };
    const {ConversationsRepository}=await import("../../src/storage/repositories/conversations.js");
    const conversations=new ConversationsRepository();conversations.upsertRoom(room);
    const {TasksRepository}=await import("../../src/storage/repositories/tasks.js");const repository=new TasksRepository();
    const history=()=>JSON.stringify(fixture.db.all("SELECT * FROM messages ORDER BY position"));
    const store = await import("../../src/workspace/task-store.js");
    const index = await import("../../src/workspace/db/tasks-index.js");
    await import("../../src/api/tasks.js");
    const first: Task = await request("POST", roomRoute, "", undefined, {
      title: "First", createdBy: "alice", assignee: "alice", subscribers: ["bob"],
    });
    expect(first.subscriberMemberIds).toEqual(["mem_alice", "mem_bob"]);
    await request("POST", `${detailRoute}/comments`, "", first.id, { author: "alice", comment: "alice wrote this" });
    const historicalEvents = history();
    const second = store.createTask(room.id, {
      title: "Second", createdBy: "user", assignee: "alice", assigneeMemberId: "mem_alice",
      subscribers: ["bob"], subscriberMemberIds: ["mem_bob"],
    });
    const legacy = { ...first, id: "task-legacy", title: "Legacy", assigneeMemberId: undefined, subscriberMemberIds: undefined, subscribers: ["alice", "bob"] };
    const missing = { ...first, id: "task-missing", title: "Missing", assigneeMemberId: "mem_missing", subscriberMemberIds: ["mem_missing"] };
    const rawTasks = [...repository.list(room.id), legacy, missing];
    repository.importTasks(room.id,rawTasks);
    const beforeRows=repository.list(room.id);

    registry.renameMember("mem_alice", "alice-new");
    registry.renameMember("mem_bob", "bob-new");
    // Old names are not active aliases, even before somebody reuses one.
    expect((await request("GET", roomRoute, "?assignee=alice")).tasks.map((t: Task) => t.id)).toEqual([legacy.id]);
    importMember("mem_reused", "alice");
    room.globalMemberIds.push("mem_reused");
    conversations.upsertRoom(room);

    const views = [
      store.getTask(room.id, first.id)!,
      store.listTasks(room.id).find((t) => t.id === first.id)!,
      store.listTaskSummaries(room.id).find((t) => t.id === first.id)!,
      store.toTaskListItem(rawTasks[0]),
      store.listAllTasks().find((t) => t.id === first.id)!,
      await request("GET", detailRoute, "", first.id),
      (await request("GET", roomRoute)).find((t: Task) => t.id === first.id),
      (await request("GET", "/api/tasks")).find((t: Task) => t.id === first.id),
      (await request("GET", roomRoute, "?status=todo")).tasks.find((t: Task) => t.id === first.id),
    ];
    views.push(index.queryRoomTasks(room.id, {})!.tasks.find((t) => t.id === first.id)!);
    for (const task of views) {
      expect(task.assignee).toBe("alice-new");
      expect(task.subscribers).toEqual(["alice-new", "bob-new"]);
      expect(task.createdBy).toBe("alice");
      expect(task.updatedAt).toBe(rawTasks[0].updatedAt);
    }
    expect(store.getTask(room.id, first.id)!.comments![0].author).toBe("alice");
    expect(store.getTask(room.id, first.id)!.comments![0].content).toBe("alice wrote this");
    expect(store.getTask(room.id, second.id)!.subscribers).toEqual(["user", "bob-new"]);
    expect(store.getTask(room.id, legacy.id)).toMatchObject({ assignee: "alice", subscribers: ["alice", "bob"], subscriberMemberIds: [] });
    expect(store.getTask(room.id, legacy.id)!.assigneeMemberId).toBeUndefined();
    expect(store.getTask(room.id, missing.id)).toMatchObject({ assignee: "mem_missing", subscribers: ["mem_missing"] });
    expect(history()).toBe(historicalEvents);
    expect(repository.list(room.id)).toEqual(beforeRows);

    const reused = await request("POST", roomRoute, "", undefined, { title: "Reused", createdBy: "user", assignee: "alice" });
    const ids = async (ref: string) => {
      const result = await request("GET", roomRoute, `?assignee=${ref}`);
      // An SQL failure must not be hidden by the API's file fallback.
      expect(index.queryRoomTasks(room.id, { assignee: ref })).toEqual(result);
      return result.tasks.map((t: Task) => t.id).sort();
    };
    expect(await ids("alice-new")).toEqual([first.id, second.id].sort());
    expect(await ids("mem_alice")).toEqual([first.id, second.id].sort());
    expect(await ids("alice")).toEqual([reused.id]); // unresolved legacy names never attach to a new owner
    expect(await ids("mem_reused")).toEqual([reused.id]);
    expect(await ids("mem_missing")).toEqual([missing.id]);
    expect(await ids("bob")).toEqual([]);
    const page = await request("GET", roomRoute, "?assignee=alice-new&limit=1&offset=1");
    expect(index.queryRoomTasks(room.id, { assignee: "alice-new", limit: 1, offset: 1 })).toEqual(page);
    expect(page.total).toBe(2);
    expect(page.tasks).toHaveLength(1);
    expect([first.id, second.id]).toContain(page.tasks[0].id);
    expect(page.tasks[0].assignee).toBe("alice-new");
    const updated = await request("PATCH", detailRoute, "", first.id, { title: "Updated" });
    expect(updated).toMatchObject({ assignee: "alice-new", subscribers: ["alice-new", "bob-new"], createdBy: "alice" });
    const commented = await request("POST", `${detailRoute}/comments`, "", first.id, { author: "bob-new", comment: "Current writer" });
    expect(commented.assignee).toBe("alice-new");
    expect(commented.comments.map((c: any) => c.author)).toEqual(["alice", "bob-new"]);
    // Ordinary unrelated writes must not persist the presentation layer either.
    const stored = repository.get(room.id,first.id);
    expect(stored).toMatchObject({ assignee: "alice", subscribers: ["alice", "bob"], createdBy: "alice" });
  });
});

describe("task participant updates (authoritative SQL)", () => {
  it.each(["api", "tool"] as const)("%s clears both assignee fields, preserves absent fields, and accepts human + ID watchers", async (surface) => {
    const registry = await import("../../src/workspace/member-registry.js");
    for (const name of ["alice", "bob"]) registry.importMemberRecord({
      id: `mem_${name}`, name, agentTemplate: "general", global: {}, unifiedModel: true,
      unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1,
    });
    const roomId = "identity-room";
    const {ConversationsRepository}=await import("../../src/storage/repositories/conversations.js");
    new ConversationsRepository().upsertRoom({id:roomId,name:"Identity",members:["alice","bob"],globalMemberIds:["mem_alice","mem_bob"],createdAt:1});
    const {TasksRepository}=await import("../../src/storage/repositories/tasks.js");const repository=new TasksRepository();
    const store = await import("../../src/workspace/task-store.js");
    const index = await import("../../src/workspace/db/tasks-index.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const resolve = vi.spyOn(roomStore, "resolveRoomMemberRef");
    await import("../../src/api/tasks.js");
    const tools = surface === "tool" ? await import("../../src/engine/tools.js") : undefined;
    const input = { title: "Participants", createdBy: "alice", assignee: "mem_alice", subscribers: ["user", "mem_bob", "bob", "user"] };
    const created = tools
      ? await tools.handleToolCallback("create_task", roomId, "alice", input,{memberId:"mem_alice"}) as any
      : await request("POST", roomRoute, "", undefined, input);
    if (tools) expect(created.ok).toBe(true);
    const id = created.taskId ?? created.id;
    expect(store.getTask(roomId, id)).toMatchObject({
      assignee: "alice", assigneeMemberId: "mem_alice", subscribers: ["user", "alice", "bob"], subscriberMemberIds: ["mem_alice", "mem_bob"],
    });
    store.addTaskComment(roomId, id, { author: "alice", content: "Historical author" });
    const stored = () => repository.get(roomId,id)!;
    const patch = async (body: Record<string, unknown>) => {
      if (tools) expect(await tools.handleToolCallback("update_task", roomId, "alice", { taskId: id, ...body },{memberId:"mem_alice"})).toMatchObject({ ok: true });
      else await request("PATCH", detailRoute, "", id, body);
      return store.getTask(roomId, id)!;
    };
    const original = stored();
    registry.renameMember("mem_alice", "alice-new");
    registry.renameMember("mem_bob", "bob-new");
    expect(await patch({ title: "Unrelated edit" })).toMatchObject({ assignee: "alice-new", subscribers: ["user", "alice-new", "bob-new"] });
    expect(stored()).toMatchObject({ assignee: original.assignee, assigneeMemberId: original.assigneeMemberId, subscribers: original.subscribers, subscriberMemberIds: original.subscriberMemberIds });
    expect(store.updateTask(roomId, id, { assignee: undefined, assigneeMemberId: undefined })).toMatchObject({ assigneeMemberId: "mem_alice" });

    for (const clear of [null, "", "  "]) {
      expect(await patch({ assignee: "mem_bob" })).toMatchObject({ assignee: "bob-new", assigneeMemberId: "mem_bob" });
      expect(stored()).toMatchObject({ assignee: "bob-new", assigneeMemberId: "mem_bob" });
      const cleared = await patch({ assignee: clear });
      expect(cleared.assignee).toBeUndefined();
      expect(cleared.assigneeMemberId).toBeUndefined();
      expect(stored()).not.toHaveProperty("assignee");
      expect(stored()).not.toHaveProperty("assigneeMemberId");
      expect((await request("GET", roomRoute, "?assignee=mem_bob")).tasks).toEqual([]);
      expect(index.queryRoomTasks(roomId, { assignee: "mem_bob" })!.tasks).toEqual([]);
    }
    expect(await patch({ subscribers: ["user", "mem_bob", "bob-new", "user"] })).toMatchObject({ subscribers: ["user", "bob-new"], subscriberMemberIds: ["mem_bob"] });
    registry.renameMember("mem_bob", "bob-latest");
    expect(store.getTask(roomId, id)).toMatchObject({ subscribers: ["user", "bob-latest"], subscriberMemberIds: ["mem_bob"], createdBy: "alice", comments: [{ author: "alice", content: "Historical author" }] });
    expect(await patch({ subscribers: ["user"] })).toMatchObject({ subscribers: ["user"], subscriberMemberIds: [] });
    expect(await patch({ subscribers: [] })).toMatchObject({ subscribers: [], subscriberMemberIds: [] });
    expect(resolve.mock.calls.some(([, ref]) => ref === "user")).toBe(false);
    resolve.mockRestore();

    // A failed resolution must not partially apply an assignee change.
    await patch({ assignee: "mem_alice" });
    const beforeFailure = repository.list(roomId);
    const invalid = { assignee: "mem_bob", subscribers: ["not-a-member"] };
    if (tools) expect(await tools.handleToolCallback("update_task", roomId, "alice", { taskId: id, ...invalid },{memberId:"mem_alice"})).toMatchObject({ ok: false });
    else {
      const res: any = {};
      await routes.get(`PATCH ${detailRoute}`)!({ body: invalid }, res, { id: roomId, taskId: id });
      expect(res.status).toBe(400);
    }
    expect(repository.list(roomId)).toEqual(beforeFailure);
    for (const clear of [{ assignee: null }, { assigneeMemberId: null }]) {
      store.updateTask(roomId, id, { assignee: "alice-new", assigneeMemberId: "mem_alice" });
      const cleared = store.updateTask(roomId, id, clear)!;
      expect(cleared.assignee).toBeUndefined();
      expect(cleared.assigneeMemberId).toBeUndefined();
    }
  });
});
