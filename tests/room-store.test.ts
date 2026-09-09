import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./unit/core-conversations-fixture.js";
const location = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/shared/config.js", async original => ({ ...await original<typeof import("../src/shared/config.js")>(), getBossmodeDir: () => location.root }));
import * as rooms from "../src/workspace/room-store.js";
import * as messages from "../src/workspace/message-store.js";
import { saveAgentDefinition } from "../src/workforce/agent-store.js";

let f: ReturnType<typeof conversationsFixture>;
beforeEach(() => { f = conversationsFixture(); location.root = f.root; });
afterEach(() => f.close());
const template = (slug: string) => saveAgentDefinition(slug, `---\nname: ${slug}\n---\nLiteral template body\n`);

it("creates and reopens room metadata and document bindings without file authority", () => {
  expect(rooms.listRooms()).toEqual([]);
  const room = rooms.createRoom("Product room", "/retired/cwd", []);
  expect(room).toMatchObject({ name: "Product room", members: [], docsPath: "product-room/" });
  expect(room.cwd).toBeUndefined();
  expect(existsSync(join(f.root, "memory/projects/product-room"))).toBe(true);
  for (const name of ["room.json", "messages.jsonl", "cursors.json"]) expect(existsSync(join(rooms.roomDir(room.id), name))).toBe(false);
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

it("rejects invalid local drafts and missing templates before creating a room", () => {
  template("pm");
  for (const { drafts, error } of [
    { drafts: [{ agent: "pm", name: "pm" }, { agent: "pm", name: "pm" }], error: /Duplicate member name/ },
    { drafts: [{ agent: "pm", name: "bad/name" }], error: /member name may contain/ },
    { drafts: [{ agent: "missing", name: "valid" }], error: /Agent not found/ },
  ]) expect(() => rooms.createRoom("Rejected", undefined, drafts)).toThrow(error);
  expect(rooms.listRooms()).toEqual([]);
});

it("creates distinct local identities from one SQL template without inheriting retired name-based config", () => {
  template("pm"); template("developer");
  writeFileSync(join(f.root, "members.json"), JSON.stringify([{ name: "dev-a", model: "retired", thinkingLevel: "high" }]));
  const room = rooms.createRoom("Local", undefined, [{ agent: "pm", name: "pm" }]);
  const pm = rooms.getRoomMembers(room.id)[0];
  expect(rooms.getCursors(room.id)[pm.id]).toBeNull();
  for (const memberName of ["dev-a", "dev-b"]) expect(rooms.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName }).ok).toBe(true);
  const members = rooms.getRoomMembers(room.id).filter(member => member.sourceAgent === "developer");
  expect(members.map(member => member.name)).toEqual(["dev-a", "dev-b"]);
  expect(new Set(members.map(member => member.id)).size).toBe(2);
  expect(members[0].config?.model).toBeUndefined();
  expect(members[0].config?.thinkingLevel).toBeUndefined();
  expect(members[0].sourceMemberId).toBeUndefined();
  expect(members[0].migratedFrom).toBeUndefined();
  expect(rooms.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" })).toMatchObject({ ok: false, code: "duplicate" });
  const latest = messages.addMessage(room.id, { sender: "user", content: "Before invite", mentions: [] });
  expect(rooms.addMember(room.id, "developer")).toBe(true);
  expect(rooms.addMember(room.id, "developer")).toBe(false);
  expect(rooms.getCursors(room.id)[rooms.findRoomMemberByName(room.id, "developer")!.id]).toBe(latest.id);
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
  const retired = join(rooms.roomDir(room.id), "messages.jsonl");
  writeFileSync(retired, "not a valid JSONL message\n");
  f.reopen();
  expect(messages.getMessages(room.id, { limit: 2 })).toEqual(records.slice(1));
  expect(messages.getMessages(room.id, { before: records[2].id })).toEqual(records.slice(0, 2));
  expect(messages.getMessagesSince(room.id, records[0].id)).toEqual(records.slice(1));
  expect(messages.getMessagesSince(room.id, null)).toEqual(records);
  expect(messages.getMessages("missing")).toEqual([]);
  expect(readFileSync(retired, "utf8")).toBe("not a valid JSONL message\n");
});
