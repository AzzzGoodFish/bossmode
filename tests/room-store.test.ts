import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./unit/core-conversations-fixture.js";
const location = vi.hoisted(() => ({ root: "" }));

import * as rooms from "../src/chat/room-store.js";
import { roomDir } from "../src/files/layout.js";
import * as messages from "../src/chat/message-store.js";

let f: ReturnType<typeof conversationsFixture>;
beforeEach(() => { f = conversationsFixture(); location.root = f.root; });
afterEach(() => f.close());

it("creates and reopens room metadata and document bindings without file authority", () => {
  expect(rooms.listRooms()).toEqual([]);
  const room = rooms.createRoom("Product room", "/retired/cwd", []);
  expect(room).toMatchObject({ name: "Product room", members: [], docsPath: "product-room/" });
  expect(room.cwd).toBeUndefined();
  expect(existsSync(join(f.root, "memory/projects/product-room"))).toBe(true);
  for (const name of ["room.json", "messages.jsonl", "cursors.json"]) expect(existsSync(join(roomDir(room.id), name))).toBe(false);
  rooms.createRoom("Other", undefined, [], undefined, { docsPath: "bossmode" });
  expect(rooms.listRooms()).toHaveLength(2);
  expect(rooms.updateRoomDocsPath(room.id, "custom/docs")?.docsPath).toBe("custom/docs/");
  f.reopen();
  expect(rooms.getRoom(room.id)?.docsPath).toBe("custom/docs/");
  expect(rooms.updateRoomDocsPath(room.id, null)?.docsPath).toBeUndefined();
  expect(rooms.getRoom("missing")).toBeNull();
  expect(() => rooms.createRoom("Unsafe", undefined, [], undefined, { docsPath: "../outside" })).toThrow(/inside/);
  expect(rooms.listRooms()).toHaveLength(2);
});

it("rejects draft objects, unknown IDs and an unselected leader before creating a room", () => {
  f.member("mem_pm", "PM");
  expect(() => rooms.createRoom("Rejected", undefined, [{ agent: "pm", name: "PM" }] as any)).toThrow(/stable member IDs/);
  expect(() => rooms.createRoom("Rejected", undefined, ["PM"])).toThrow(/Member not found/);
  expect(() => rooms.createRoom("Rejected", undefined, ["mem_missing"])).toThrow(/Member not found/);
  expect(() => rooms.createRoom("Rejected", undefined, ["mem_pm"], undefined, {promptLeaderMemberId: "mem_missing"})).toThrow(/one of memberIds/);
  expect(rooms.listRooms()).toEqual([]);
});

it("creates only existing contacts and never inherits retired template or name-based config", () => {
  f.member("mem_pm", "PM"); f.member("mem_a", "开发 A"); f.member("mem_b", "dev `B`");
  writeFileSync(join(f.root, "members.json"), JSON.stringify([{ name: "开发 A", model: "retired", thinkingLevel: "high" }]));
  const room = rooms.createRoom("Contacts", undefined, ["mem_pm", "mem_a", "mem_a"], undefined, {promptLeaderMemberId: "mem_a"});
  expect(room.globalMemberIds).toEqual(["mem_pm", "mem_a"]);
  expect(room.promptLeaderMemberId).toBe("mem_a");
  expect(rooms.getCursors(room.id).mem_pm).toBeNull();
  const members = rooms.getRoomMembers(room.id);
  expect(members.map(m => [m.id, m.name])).toEqual([["mem_pm", "PM"], ["mem_a", "开发 A"]]);
  expect(members[1].config).toBeUndefined();
  expect(members[1].sourceMemberId).toBe("mem_a");
  expect(members[1].migratedFrom).toBeUndefined();
  const latest = messages.addMessage(room.id, { sender: "user", content: "Before invite", mentions: [] });
  expect(rooms.inviteGlobalMember(room.id, {id: "mem_b", name: "ignored stale name", agentTemplate: "ignored"}).ok).toBe(true);
  expect(rooms.getCursors(room.id).mem_b).toBe(latest.id);
  expect(rooms.inviteGlobalMember(room.id, {id: "mem_b", name: "dev `B`", agentTemplate: "general"})).toMatchObject({ok: false, code: "duplicate"});
  expect(rooms.getRoomMembers(room.id).at(-1)).toMatchObject({id: "mem_b", name: "dev `B`"});
  f.reopen();
  expect(rooms.getRoom(room.id)?.globalMemberIds).toEqual(["mem_pm", "mem_a", "mem_b"]);
  expect(f.db.get<{n:number}>("SELECT COUNT(*) n FROM members")!.n).toBe(3);
});

it("keeps global membership and cursors on stable IDs across rename, restart and roster clearing", () => {
  f.member("mem_one", "Before");
  const room = rooms.createRoom("Global", undefined, []);
  const latest = messages.addMessage(room.id, { sender: "user", content: "Before invite", mentions: [] });
  expect(rooms.inviteGlobalMember(room.id, { id: "mem_one", name: "Before", agentTemplate: "general" }).ok).toBe(true);
  expect(rooms.getCursors(room.id).mem_one).toBe(latest.id);
  rooms.setCursor(room.id, "mem_one", null);
  f.member("mem_one", "After 🐟");
  f.reopen();
  expect(rooms.getRoomMembers(room.id)).toMatchObject([{ id: "mem_one", name: "After 🐟" }]);
  expect(rooms.findRoomMemberByName(room.id, "Before")).toBeNull();
  expect(rooms.getCursors(room.id).mem_one).toBeNull();
  rooms.setCursor(room.id, "mem_one", latest.id);
  expect(rooms.getCursors(room.id).mem_one).toBe(latest.id);
  rooms.stampGlobalMemberIds(room.id, []);
  f.reopen();
  expect(rooms.getRoomMembers(room.id)).toEqual([]);
});

it("derives legacy overrides only from the supplied room, never from retired members.json", () => {
  const room = { id: "legacy", name: "Legacy", members: ["qa"], createdAt: 0, memberOverrides: { qa: { model: "room-model" } } };
  writeFileSync(join(f.root, "members.json"), "invalid retired data");
  const [member] = rooms.getRoomMembersFromRoom(room);
  expect(member).toMatchObject({ name: "qa", sourceAgent: "qa", config: { model: "room-model" } });
  expect(member.sourceMemberId).toBeUndefined();
  expect(member.config?.credentialId).toBeUndefined();
  expect(member.config?.skills).toBeUndefined();
});

it("serves message windows after restart and ignores retired JSONL rewrites", () => {
  const room = rooms.createRoom("Messages", undefined, []);
  const records = ["one", "two", "three"].map(content => messages.addMessage(room.id, { sender: "user", content, mentions: [] }));
  const retired = join(roomDir(room.id), "messages.jsonl");
  writeFileSync(retired, "not a valid JSONL message\n");
  f.reopen();
  expect(messages.getMessages(room.id, { limit: 2 })).toEqual(records.slice(1));
  expect(messages.getMessages(room.id, { before: records[2].id })).toEqual(records.slice(0, 2));
  expect(messages.getMessagesSince(room.id, records[0].id)).toEqual(records.slice(1));
  expect(messages.getMessagesSince(room.id, null)).toEqual(records);
  expect(messages.getMessages("missing")).toEqual([]);
  expect(readFileSync(retired, "utf8")).toBe("not a valid JSONL message\n");
});
