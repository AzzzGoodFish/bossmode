import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { createMember } from "../../src/member/member-registry.js";
import { createRoom, stampGlobalMemberIds } from "../../src/chat/room-store.js";
import { addMessage } from "../../src/chat/message-store.js";
import { handleToolCallback } from "../../src/agent/tools/tools.js";
import { createBossmodeSdkTools } from "../../src/agent/runtime/bossmode-sdk-tools.js";

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });

function seed() {
  const dev = createMember({ name: "dev" });
  const peer = createMember({ name: "peer", title: "Peer of dev" });
  const room = createRoom("Split room", undefined, []);
  stampGlobalMemberIds(room.id, [dev.id, peer.id]);
  addMessage(room.id, { sender: "user", content: "alpha discussion", mentions: [] });
  addMessage(room.id, { sender: "peer", content: "beta finding about widget", mentions: [] });
  addMessage(room.id, { sender: "peer", content: "gamma follow up", mentions: [] });
  const call = (tool: string, params: Record<string, unknown>) => handleToolCallback(tool, room.id, dev.name, params, { memberId: dev.id });
  return { dev, peer, room, call };
}

describe("chat_read / chat_search split", () => {
  it("chat_read reads windows and rejects text queries with guidance", async () => {
    const { room, call } = seed();
    const rows = await call("chat_read", { chat: room.id, limit: 2 }) as any[];
    expect(rows.map(r => r.content)).toEqual(["beta finding about widget", "gamma follow up"]);

    const queryRejected = await call("chat_read", { chat: room.id, query: "beta" }) as any;
    expect(queryRejected.ok).toBe(false);
    expect(queryRejected.error).toMatch(/use chat_search/);

    const senderRejected = await call("chat_read", { chat: room.id, from: "peer" }) as any;
    expect(senderRejected.ok).toBe(false);
    expect(senderRejected.error).toMatch(/chat_search/);

    const scopeRejected = await call("chat_read", { scope: "room:x" }) as any;
    expect(scopeRejected.ok).toBe(false);
    expect(scopeRejected.error).toMatch(/use 'chat'/);
  });

  it("chat_search requires a query; returns compact hits and supports the sender filter", async () => {
    const { call } = seed();
    const missing = await call("chat_search", { chat: "Split room" }) as any;
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/query is required/);

    const hits = await call("chat_search", { chat: "Split room", query: "widget" }) as any[];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sender: "peer", content: "beta finding about widget" });
    expect(hits[0].seq).toBeGreaterThan(0);

    const bySender = await call("chat_search", { chat: "Split room", query: "follow", from: "peer" }) as any[];
    expect(bySender.map(h => h.content)).toEqual(["gamma follow up"]);

    const badArg = await call("chat_search", { chat: "Split room", query: "x", from_seq: 1 }) as any;
    expect(badArg.ok).toBe(false);
    expect(badArg.error).toMatch(/from_seq/);
  });

  it("chat_search truncates hit snippets instead of returning full windows", async () => {
    const { room, call } = seed();
    const long = "x".repeat(500);
    addMessage(room.id, { sender: "peer", content: `needle ${long}`, mentions: [] });
    const hits = await call("chat_search", { chat: room.id, query: "needle" }) as any[];
    expect(hits[0].content.length).toBeLessThanOrEqual(200);
    expect(hits[0].content.endsWith("…")).toBe(true);
  });

  it("chat_info returns room name/description/members and the DM counterpart", async () => {
    const { room, call } = seed();
    await call("chat_edit", { chat: room.id, description: "Split room description line" });
    const info = await call("chat_info", { chat: "Split room" }) as any;
    expect(info.ok).toBe(true);
    expect(info.chat).toMatchObject({ kind: "room", name: "Split room" });
    expect(info.chat.description).toContain("Split room description line");
    expect(info.chat.members.map((m: any) => m.name).sort()).toEqual(["dev", "peer"]);

    const dm = await call("chat_info", { chat: "user" }) as any;
    expect(dm.chat).toMatchObject({ kind: "dm", counterpart: "user" });

    const missing = await call("chat_info", {}) as any;
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/chat is required/);
  });

  it("gateway call executes chat_info through the bossmode tool", async () => {
    const { dev, room } = seed();
    const gateway = createBossmodeSdkTools({ roomId: room.id, memberId: dev.id }).find(t => t.name === "bossmode")!;
    const result = await (gateway.execute as any)("g", { action: "call", tool: "chat_info", args: { chat: "Split room" } });
    const text = result.content[0].text as string;
    expect(text).toContain("Split room");
    expect(text).toContain("members: dev, peer");
  });
});
