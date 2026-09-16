import { randomUUID } from "node:crypto";
import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * 0.20 rc.5 流B: DM failure notices user-visible (G1) + scope-routed egress +
 * phantom-dir hygiene + system notices fully hidden from members (fish 2026-08-04).
 *
 * - postMessage with a "dm:<memberId>" address routes to the member-owned DM
 *   store (never a phantom rooms/dm:<id>/messages.jsonl).
 * - DM instances share the single wireInstanceEvents subscription: a failed
 *   turn posts a system notice into the DM store + broadcasts to dm:<id>.
 * - Ordinary SQL startup imports phantom history, backs up and retires sources,
 *   and reopens without replaying historical activation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let fixture: ReturnType<typeof coreFixture>;
let dir: string;

const broadcastToRoom = vi.fn();

vi.mock("../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/server/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/ws.js")>();
  return {
    ...actual,
    broadcastToRoom: (...args: unknown[]) => broadcastToRoom(...args),
    broadcastToAgentSubscribers: vi.fn(),
  };
});

describe("scope-routed postMessage", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    broadcastToRoom.mockClear();
  });

  afterEach(() => {
    fixture.close();
  });

  it("dm:<id> address writes the DM store, broadcasts to dm:<id>, leaves no phantom", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const dmScope = `dm:${member.id}`;

    const { postMessage } = await import("../../src/chat/message-bus.js");
    const msg = postMessage(dmScope, "system", `Member "architect" request failed. Error: boom`);

    const store = await import("../../src/chat/dm-message-store.js");
    const all = store.readAllDmMessages(member.id);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(msg.id);
    expect(all[0].sender).toBe("system");
    expect(all[0].content).toContain("request failed");

    // No phantom room dir / messages.jsonl.
    expect(existsSync(join(dir, "rooms", dmScope, "messages.jsonl"))).toBe(false);

    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    const [targetRoom, event] = broadcastToRoom.mock.calls[0] as any[];
    expect(targetRoom).toBe(dmScope);
    expect(event.type).toBe("room:message");
    expect(event.message.content).toContain("request failed");
  });
});

describe("DM instance unified event wiring (G1)", () => {
  let subscribeCb: ((event: any) => void) | undefined;
  let createAgentCalls: number;
  let promptImpl: () => Promise<void>;

  const fakeRuntime = () => ({
    name: "pi-cli",
    createAgent: vi.fn(async () => {
      createAgentCalls += 1;
      return {
        prompt: vi.fn(async (message: string, options?: { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void }) => {
          fixture.db.transaction(() => options?.beforeDispatch?.({ attemptId: `mock:${randomUUID()}`, dispatchIndex: 0, message }));
          await promptImpl();
        }),
        steer: vi.fn(),
        abort: vi.fn(),
        destroy: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
        subscribe: (fn: (event: any) => void) => {
          subscribeCb = fn;
          return () => {};
        },
      };
    }),
  });

  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    broadcastToRoom.mockClear();
    subscribeCb = undefined;
    createAgentCalls = 0;
    promptImpl = async () => {};
  });

  afterEach(async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.shutdownAll();
    fixture.close();
  });

  async function setup() {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({
      name: "architect",
      agentTemplate: "architect",
      model: "anthropic/claude-sonnet",
      credentialId: "cred-1",
    });
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);
    return { reg, member, manager };
  }

  it("failed DM turn posts a user-visible system notice into the DM store (no phantom)", async () => {
    const { member, manager } = await setup();
    const dmScope = `dm:${member.id}`;
    promptImpl = async () => {
      subscribeCb?.({ type: "agent_start" });
      subscribeCb?.({ type: "message_end", text: "", stopReason: "error", errorMessage: "provider exploded" });
      subscribeCb?.({ type: "agent_end" });
    };

    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(1);

    const store = await import("../../src/chat/dm-message-store.js");
    const all = store.readAllDmMessages(member.id);
    const notice = all.find((m) => m.sender === "system" && m.content.includes("request failed"));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain("provider exploded");

    // No phantom rooms/dm:<id>/messages.jsonl.
    expect(existsSync(join(dir, "rooms", dmScope, "messages.jsonl"))).toBe(false);

    // Broadcast to dm:<id> subscribers so the DM UI updates live.
    const systemBroadcast = broadcastToRoom.mock.calls.find(
      ([room, event]: any[]) => room === dmScope && event.message?.sender === "system",
    );
    expect(systemBroadcast).toBeDefined();
  });

  it("unexpected runtime exit notifies the DM and drops the dead instance (respawn on next activation)", async () => {
    const { member, manager } = await setup();
    promptImpl = async () => {
      subscribeCb?.({ type: "agent_start" });
      subscribeCb?.({ type: "runtime_exit", unexpected: true, code: 1, signal: null, stderrTail: "segfault-ish" });
    };

    await manager.activateDmMember(member.id);
    const store = await import("../../src/chat/dm-message-store.js");
    const notice = store.readAllDmMessages(member.id).find((m) => m.content.includes("runtime ended unexpectedly"));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain("exit 1");

    // Dead instance dropped → next activation creates a fresh one.
    promptImpl = async () => {};
    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(2);
  });

  it("unconfigured DM member posts a user-visible notice instead of silent return", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({ name: "architect", agentTemplate: "architect" }); // no model/credential
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(0);
    const store = await import("../../src/chat/dm-message-store.js");
    const notice = store.readAllDmMessages(member.id).find((m) => m.sender === "system");
    expect(notice?.content).toContain("hasn't selected a model yet");
  });

  it("DM instance creation failure posts a user-visible notice", async () => {
    const { member, manager } = await setup();
    const failing = {
      name: "pi-cli",
      createAgent: vi.fn(async () => {
        createAgentCalls += 1;
        throw new Error("provider config missing");
      }),
    };
    await manager.shutdownAll();
    (manager as any).initAgentManager({ get: () => failing, getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    const store = await import("../../src/chat/dm-message-store.js");
    const notice = store.readAllDmMessages(member.id).find((m) => m.sender === "system");
    expect(notice?.content).toContain("Failed to create member");
    expect(notice?.content).toContain("provider config missing");
  });

  it("runtime onChat callback persists via the single scope-routed egress", async () => {
    const { member, manager } = await setup();
    let capturedCallbacks: any;
    const runtime = {
      name: "pi-cli",
      createAgent: vi.fn(async (opts: any) => {
        createAgentCalls += 1;
        capturedCallbacks = opts.callbacks;
        return {
          prompt: vi.fn(async (message: string, options?: { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void }) => {
            fixture.db.transaction(() => options?.beforeDispatch?.({ attemptId: `mock:${randomUUID()}`, dispatchIndex: 0, message }));
            await promptImpl();
          }),
          steer: vi.fn(),
          abort: vi.fn(),
          destroy: vi.fn(),
          waitForIdle: vi.fn(async () => {}),
          subscribe: (fn: (event: any) => void) => {
            subscribeCb = fn;
            return () => {};
          },
        };
      }),
    };
    const managerAny = manager as any;
    await manager.shutdownAll();
    managerAny.initAgentManager({ get: () => runtime, getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    await capturedCallbacks.onChat("hello from dm");

    const store = await import("../../src/chat/dm-message-store.js");
    const msgs = store.readAllDmMessages(member.id);
    expect(msgs.some((m) => m.sender === "architect" && m.content === "hello from dm")).toBe(true);
    expect(broadcastToRoom.mock.calls.some(([room]: any[]) => room === `dm:${member.id}`)).toBe(true);
  });
});

describe("DM historical messages through ordinary storage startup", () => {
  let database: import("../../src/data/database.js").Database | undefined;
  beforeEach(() => {
    vi.resetModules();
    dir = process.env.BOSSMODE_DIR!;
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    database?.close();
    database = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startup() {
    const { prepareCoreStorage } = await import("../../src/data/core-startup.js");
    const result = await prepareCoreStorage({ root: dir, bundledCatalog: [], initialConfig: {
      auth: { username: "test", passwordHash: "fixture" }, apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 }, runtime: {},
    } });
    database = result.db;
    (await import("../../src/data/database.js")).bindDatabase(database);
    return result;
  }

  it("imports phantom messages into the owned DM scope, backs up and retires sources; restart is a no-op", async () => {
    const memberId = "mem_historical";
    const phantomDir = join(dir, "rooms", `dm:${memberId}`);
    mkdirSync(phantomDir, { recursive: true });
    const phantom = [
      { id: "p1", seq: 1, ts: 1000, sender: "system", content: 'Member "pm" request failed. Error: old', mentions: [] },
      { id: "p2", seq: 2, ts: 2000, sender: "system", content: 'Member "pm" runtime ended unexpectedly (exit 1).', mentions: [] },
    ];
    const source = phantom.map(m => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(join(phantomDir, "messages.jsonl"), source);
    writeFileSync(join(phantomDir, ".seq"), "3");

    const result = await startup();
    expect(result.migrated).toBe(true);
    const store = await import("../../src/chat/dm-message-store.js");
    // Current importer preserves historical IDs, timestamps and sequence values.
    expect(store.readAllDmMessages(memberId)).toEqual(phantom);
    expect(database!.get("SELECT kind, member_id FROM scopes WHERE id=?", `dm:${memberId}`))
      .toEqual({ kind: "dm", member_id: memberId });
    expect(database!.all("SELECT * FROM rooms")).toEqual([]);
    expect(database!.all("SELECT * FROM outbox")).toEqual([]);
    for (const filename of ["messages.jsonl", ".seq"]) {
      expect(existsSync(join(phantomDir, filename))).toBe(false);
      const record = database!.get<{ backup_path: string; retired_at: number }>(
        "SELECT backup_path,retired_at FROM storage_upgrade_files WHERE path=?", `rooms/dm:${memberId}/${filename}`)!;
      expect(record.retired_at).toBeTypeOf("number");
      expect(readFileSync(join(dir, record.backup_path), "utf8")).toBe(filename === ".seq" ? "3" : source);
    }
    database!.close();
    database = undefined;
    const again = await startup();
    expect(again.migrated).toBe(false);
    expect(store.readAllDmMessages(memberId)).toEqual(phantom);
  });

  it("starts cleanly without phantom history and does not invent a DM or room", async () => {
    await startup();
    expect(database!.all("SELECT * FROM scopes")).toEqual([]);
    expect(database!.all("SELECT * FROM messages")).toEqual([]);
  });
});

describe("system notices hidden from members (fish 2026-08-04)", () => {
  it("predicate hides all sender=system except typed task/knowledge events", async () => {
    const { isSystemNoticeHiddenFromMembers } = await import("../../src/kernel/runtime-error-limit.js");
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", content: `Member "pm" request failed.` })).toBe(true);
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", content: `Member "pm" finished without replying.` })).toBe(true);
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", content: `Member "pm" hasn't selected a model yet.` })).toBe(true);
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", content: `Member "pm" Member was cut off due to output length again.` })).toBe(true);
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", type: "task_event", content: "Task created" })).toBe(false);
    expect(isSystemNoticeHiddenFromMembers({ sender: "system", type: "knowledge_event", content: "[Knowledge] pm updated" })).toBe(false);
    expect(isSystemNoticeHiddenFromMembers({ sender: "pm", content: "hi" })).toBe(false);
    expect(isSystemNoticeHiddenFromMembers({ sender: "user", content: "hi" })).toBe(false);
  });
});
