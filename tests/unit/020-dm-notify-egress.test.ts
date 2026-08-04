/**
 * 0.20 rc.5 流B: DM failure notices user-visible (G1) + scope-routed egress +
 * phantom-dir hygiene + system notices fully hidden from members (fish 2026-08-04).
 *
 * - postMessage with a "dm:<memberId>" address routes to the member-owned DM
 *   store (never a phantom rooms/dm:<id>/messages.jsonl).
 * - DM instances share the single wireInstanceEvents subscription: a failed
 *   turn posts a system notice into the DM store + broadcasts to dm:<id>.
 * - Phantom messages.jsonl sweep migrates legacy phantom content into the DM
 *   store (snapshot + idempotent-by-absence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

const broadcastToRoom = vi.fn();

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return {
    ...actual,
    broadcastToRoom: (...args: unknown[]) => broadcastToRoom(...args),
    broadcastToAgentSubscribers: vi.fn(),
  };
});

function seedAgent(name: string) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: "${name}"\n---\n\nYou are ${name}.\n`,
    "utf-8",
  );
}

describe("scope-routed postMessage", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-dm-egress-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    broadcastToRoom.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dm:<id> address writes the DM store, broadcasts to dm:<id>, leaves no phantom", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const dmScope = `dm:${member.id}`;

    const { postMessage } = await import("../../src/communication/message-bus.js");
    const msg = postMessage(dmScope, "system", `Member "architect" request failed. Error: boom`);

    const store = await import("../../src/workspace/dm-message-store.js");
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
        prompt: vi.fn(() => promptImpl()),
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-dm-g1-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("architect");
    broadcastToRoom.mockClear();
    subscribeCb = undefined;
    createAgentCalls = 0;
    promptImpl = async () => {};
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({
      name: "architect",
      agentTemplate: "architect",
      model: "anthropic/claude-sonnet",
      credentialId: "cred-1",
    });
    const manager = await import("../../src/engine/agent-manager.js");
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

    const store = await import("../../src/workspace/dm-message-store.js");
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
    const store = await import("../../src/workspace/dm-message-store.js");
    const notice = store.readAllDmMessages(member.id).find((m) => m.content.includes("runtime ended unexpectedly"));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain("exit 1");

    // Dead instance dropped → next activation creates a fresh one.
    promptImpl = async () => {};
    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(2);
  });

  it("unconfigured DM member posts a user-visible notice instead of silent return", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({ name: "architect", agentTemplate: "architect" }); // no model/credential
    const manager = await import("../../src/engine/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(0);
    const store = await import("../../src/workspace/dm-message-store.js");
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
    (manager as any).initAgentManager({ get: () => failing, getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    const store = await import("../../src/workspace/dm-message-store.js");
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
          prompt: vi.fn(() => promptImpl()),
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
    managerAny.initAgentManager({ get: () => runtime, getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    await capturedCallbacks.onChat("hello from dm");

    const store = await import("../../src/workspace/dm-message-store.js");
    const msgs = store.readAllDmMessages(member.id);
    expect(msgs.some((m) => m.sender === "architect" && m.content === "hello from dm")).toBe(true);
    expect(broadcastToRoom.mock.calls.some(([room]: any[]) => room === `dm:${member.id}`)).toBe(true);
  });
});

describe("dm phantom messages migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-dm-phantom-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges phantom messages.jsonl into the DM store, snapshots, removes; re-run is a no-op", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({ name: "pm", agentTemplate: "pm" });

    const phantomDir = join(dir, "rooms", `dm:${member.id}`);
    mkdirSync(phantomDir, { recursive: true });
    const phantom = [
      { id: "p1", seq: 1, ts: 1000, sender: "system", content: `Member "pm" request failed. Error: old`, mentions: [] },
      { id: "p2", seq: 2, ts: 2000, sender: "system", content: `Member "pm" runtime ended unexpectedly (exit 1).`, mentions: [] },
    ];
    writeFileSync(join(phantomDir, "messages.jsonl"), phantom.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
    writeFileSync(join(phantomDir, ".seq"), "3", "utf-8");

    const { runDmPhantomMessagesMigration } = await import("../../src/workspace/dm-phantom-messages-migration.js");
    runDmPhantomMessagesMigration();

    const store = await import("../../src/workspace/dm-message-store.js");
    const all = store.readAllDmMessages(member.id);
    expect(all).toHaveLength(2);
    expect(all[0].content).toContain("request failed");
    expect(all[1].content).toContain("runtime ended unexpectedly");
    // Re-sequenced fresh, order preserved by ts.
    expect(all[0].seq).toBeLessThan(all[1].seq!);

    // Phantom gone, snapshot kept.
    expect(existsSync(join(phantomDir, "messages.jsonl"))).toBe(false);
    expect(existsSync(join(phantomDir, ".seq"))).toBe(false);
    const snapshot = join(dir, "pi-agent", "runtime", ".migration-snapshots", "dm-phantom-messages-v1", `dm:${member.id}`, "messages.jsonl");
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot, "utf-8")).toContain("request failed");

    // Idempotent: second run does not duplicate.
    runDmPhantomMessagesMigration();
    expect(store.readAllDmMessages(member.id)).toHaveLength(2);
  });

  it("skips cleanly when no phantom exists", async () => {
    const { runDmPhantomMessagesMigration } = await import("../../src/workspace/dm-phantom-messages-migration.js");
    expect(() => runDmPhantomMessagesMigration()).not.toThrow();
  });
});

describe("system notices hidden from members (fish 2026-08-04)", () => {
  it("predicate hides all sender=system except typed task/knowledge events", async () => {
    const { isSystemNoticeHiddenFromMembers } = await import("../../src/shared/runtime-error-limit.js");
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

describe("write_memory receipt wording", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-mem-receipt-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    seedAgent("pm");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("receipt says Reload or fresh session, not 'next activation'", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("r", dir, [{ agent: "pm", name: "pm" }], undefined);
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const result = (await handleToolCallback("write_memory", room.id, "pm", {
      asset: "principles",
      content: "## Rules\n- test\n",
      reason: "test",
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Reload or a fresh session");
    expect(result.message).not.toContain("next member activation");
  });
});
