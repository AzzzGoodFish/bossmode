/** Historical JSONL imports are strict and recoverable. Live reads use SQL only;
 * Corrupt historical events are quarantined rather than becoming live fallback reads. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { bindDatabase, openDatabase } from "../../src/data/database.js";
import { storeRoom } from "../../src/chat/conversations.js";
import { importMessage, readMessages } from "../../src/data/repositories/message-repository.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { discoverLegacyInventory, type LegacySourceEntry } from "../../src/app/upgrade/inventory.js";
import { importLegacyConversations } from "../../src/app/upgrade/conversations.js";
import { prepareStorageUpgrade } from "../../src/app/upgrade/run.js";
import { type UpgradeImportContext } from "../../src/app/upgrade/inventory.js";
import { getMessages, readAllMessages, getMessagesSince, getLatestMessageId, searchMessages } from "../../src/chat/message-store.js";
import { loadEventsFromDisk } from "../../src/agent/events.js";

let fixture: ReturnType<typeof coreFixture>;
let upgraded: Awaited<ReturnType<typeof prepareStorageUpgrade>> | undefined;
const messagePath = "rooms/room-a/messages.jsonl";
const eventPath = "rooms/room-a/agent-events/pm.jsonl";
const retainedMessage = { id: "prior", seq: 1, ts: 1, sender: "user", content: "Existing SQL fact", mentions: [] };
const goodMsg = (id: string, content: string, seq: number) => JSON.stringify({
  id, seq, ts: 1_700_000_000_000 + seq, sender: "user", content, mentions: [], type: "message",
});
function write(path: string, body: string) {
  const file = join(fixture.root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}
function upgrade() {
  fixture.db.close();
  let entries: LegacySourceEntry[] = [];
  return prepareStorageUpgrade({
    root: fixture.root, formatVersion: 1, migrations: coreStorageMigrations,
    collectLegacySources: async () => (entries = discoverLegacyInventory(fixture.root).entries),
    importData: async (ctx: UpgradeImportContext) => { await importLegacyConversations(ctx, entries); },
    validate: async () => {},
  });
}
async function importAndBind() {
  upgraded = await upgrade();
  bindDatabase(upgraded.db);
  expect(upgraded.db.all("SELECT * FROM outbox")).toEqual([]);
  expect(readMessages("existing-room", upgraded.db)).toEqual([retainedMessage]);
}
function assertOriginalUntouched(path: string, body: string) {
  expect(readFileSync(join(fixture.root, path), "utf8")).toBe(body);
  const original = openDatabase(fixture.path);
  try {
    expect(readMessages("room-a", original)).toEqual([]);
    expect(readMessages("existing-room", original)).toEqual([retainedMessage]);
    expect(original.all("SELECT * FROM agent_events")).toEqual([]);
    expect(original.get("SELECT value FROM storage_meta WHERE key='core-authority'")).toBeUndefined();
  } finally { original.close(); }
}

beforeEach(() => {
  fixture = coreFixture();
  storeRoom({ id: "existing-room", name: "Existing", members: [], createdAt: 1 }, fixture.db);
  importMessage(fixture.db, "existing-room", retainedMessage);
});
afterEach(() => { upgraded?.db.close(); upgraded = undefined; fixture.close(); });

describe("historical JSONL import and SQL queries", () => {
  it("empty historical file imports an empty SQL scope", async () => {
    write(messagePath, "");
    await importAndBind();
    expect(getMessages("room-a")).toEqual([]);
    expect(readAllMessages("room-a")).toEqual([]);
    expect(existsSync(join(fixture.root, messagePath))).toBe(false);
  });

  it("all-good history preserves every message, order, search and latest; live reads ignore stale JSONL", async () => {
    const body = [goodMsg("m1", "hello", 1), goodMsg("m2", "world", 2), goodMsg("m3", "!", 3)].join("\n") + "\n";
    write(messagePath, body);
    await importAndBind();
    expect(readAllMessages("room-a").map(m => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(getMessages("room-a").map(m => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(getMessagesSince("room-a", "m1").map(m => m.id)).toEqual(["m2", "m3"]);
    expect(searchMessages("room-a", { query: "world" }).messages.map(m => m.id)).toEqual(["m2"]);
    expect(getLatestMessageId("room-a")).toBe("m3");
    const backup = upgraded!.db.get<{ backup_path: string }>("SELECT backup_path FROM storage_upgrade_files WHERE path=?", messagePath)!;
    expect(readFileSync(join(fixture.root, backup.backup_path), "utf8")).toBe(body);
    write(messagePath, goodMsg("stale", "not authoritative", 4) + "\n");
    expect(getLatestMessageId("room-a")).toBe("m3");
    expect(searchMessages("room-a", { query: "not authoritative" }).messages).toEqual([]);
  });

  it.each([
    ["truncated trailing JSON", goodMsg("m1", "first", 1) + '\n{"id":"m-bad","content":"redis is\n', "invalid-json"],
    ["middle corruption", goodMsg("m1", "a", 1) + '\n{not-json\n\n' + goodMsg("m2", "b", 2) + "\n", "invalid-json"],
    ["valid but unterminated final record", goodMsg("m1", "first", 1), "unterminated-jsonl-line"],
  ])("%s rejects cutover, retaining source bytes and prior SQL", async (_name, body, error) => {
    write(messagePath, body);
    await expect(upgrade()).rejects.toThrow(error);
    assertOriginalUntouched(messagePath, body);
  });

  it("blank lines and CRLF preserve neighboring message order and query results", async () => {
    write(messagePath, "\r\n" + goodMsg("m1", "a", 1) + "\r\n \t\r\n" + goodMsg("m2", "b", 2) + "\r\n");
    await importAndBind();
    expect(readAllMessages("room-a").map(m => m.id)).toEqual(["m1", "m2"]);
    expect(searchMessages("room-a", { query: "b" }).messages.map(m => m.id)).toEqual(["m2"]);
  });

  it("late corruption never publishes already committed staging batches; corrected retry imports once", async () => {
    const good = Array.from({ length: 130 }, (_, i) => goodMsg(`m${i + 1}`, `body${i + 1}`, i + 1)).join("\n") + "\n";
    write(messagePath, good + "{bad}\n");
    await expect(upgrade()).rejects.toThrow("invalid-json");
    assertOriginalUntouched(messagePath, good + "{bad}\n");
    const staged = openDatabase(join(fixture.root, "upgrades/staging.sqlite"));
    try {
      expect(staged.get("SELECT COUNT(*) n FROM messages WHERE scope_id='room-a'")).toEqual({ n: 128 });
      expect(readMessages("existing-room", staged)).toEqual([retainedMessage]);
    }
    finally { staged.close(); }
    write(messagePath, good);
    await importAndBind();
    expect(readAllMessages("room-a")).toHaveLength(130);
    expect(getLatestMessageId("room-a")).toBe("m130");
    upgraded!.db.close();
    await importAndBind();
    expect(upgraded!.migrated).toBe(false);
    expect(readAllMessages("room-a")).toHaveLength(130);
  });

  it("corrupt historical agent events import the surrounding executions and preserve the exact skipped line", async () => {
    const body = '{"type":"agent_start","ts":1}\n{"type":"tool_start","partial\n{"type":"agent_end","ts":3}\n';
    const file = write(eventPath, body);
    await importAndBind();
    expect(loadEventsFromDisk("room-a", "legacy-unresolved:pm").map(e => e.type)).toEqual(["agent_start", "agent_end"]);
    const rows = upgraded!.db.all<{ value: string }>("SELECT value FROM storage_meta WHERE key LIKE 'legacy-invalid-event-v1:%'");
    expect(rows).toHaveLength(1);
    const quarantined = JSON.parse(rows[0].value);
    expect(quarantined).toMatchObject({ path: eventPath, ordinal: 2, lineNumber: 2, reason: "invalid-json" });
    expect(Buffer.from(quarantined.rawBase64, "base64").toString()).toBe('{"type":"tool_start","partial\n');
    const backup = upgraded!.db.get<{ backup_path: string }>("SELECT backup_path FROM storage_upgrade_files WHERE path=?", eventPath)!;
    expect(readFileSync(join(fixture.root, backup.backup_path), "utf8")).toBe(body);
    expect(existsSync(file)).toBe(false);
  });

  it("valid event history retains order under an unresolved owner, never the current same-name member", async () => {
    const { importMemberRecord } = await import("../../src/app/member-actions.js");
    importMemberRecord({ id: "mem_pm", name: "pm", agentTemplate: "general", unifiedModel: true, unifiedExtensions: true,
      global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
      scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
    write(eventPath, '\n{"type":"agent_start","ts":1}\n\n{"type":"agent_end","ts":3}\n');
    await importAndBind();
    expect(loadEventsFromDisk("room-a", "legacy-unresolved:pm").map(e => e.type)).toEqual(["agent_start", "agent_end"]);
    expect(loadEventsFromDisk("room-a", "mem_pm")).toEqual([]);
    expect(upgraded!.db.all("SELECT DISTINCT owner_key,member_id FROM agent_events")).toEqual([{ owner_key: "legacy-unresolved:pm", member_id: null }]);
  });

  it("room source ownership mismatch rejects cutover and preserves its bytes", async () => {
    const path = "rooms/room-a/room.json";
    const body = JSON.stringify({ id: "wrong-room", name: "Wrong", members: [], createdAt: 1 });
    write(path, body);
    await expect(upgrade()).rejects.toThrow("ownership mismatch");
    assertOriginalUntouched(path, body);
  });

});
