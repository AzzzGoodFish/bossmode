import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory } from "../../src/storage/legacy-inventory.js";
import { importLegacyConversations } from "../../src/storage/upgrade-conversations.js";
import type { UpgradeImportContext } from "../../src/storage/upgrade-runner.js";
import { readAgentEvents, pageActivity, rebuildEventAggregates } from "../../src/storage/event-repository.js";
import { readUsageReport } from "../../src/storage/usage-repository.js";

let fixture: ReturnType<typeof coreFixture>;
let sourceRoot: string;
const scopes = ["room-parent", "dm:rm_engineer", "topic:fixture"];
const base = Date.parse("2026-08-01T00:00:00Z");
function event(n: number, model?: string) { return { type: "message_end", ts: base + n, ...(model === undefined ? {} : { model }), usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n * 0.25 } }; }
function eventPath(scope: string, stem = "rm_engineer") {
  return scope.startsWith("topic:") ? `rooms/room-parent/topics/${scope.slice(6)}/agent-events/${stem}.jsonl` : `rooms/${scope}/agent-events/${stem}.jsonl`;
}
function write(path: string, content: string) {
  const target = join(sourceRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); return target;
}
function events(scope: string, stem: string, values: object[]) { return write(eventPath(scope, stem), values.map(v => JSON.stringify(v)).join("\n") + "\n"); }
function context() {
  const entries = discoverLegacyInventory(sourceRoot).entries;
  const ctx: UpgradeImportContext = { db: fixture.db, root: fixture.root, sourceRoot, sourceFiles: entries.map(e => e.path), previousDatabase: undefined, legacy: true, progress() {}, stageAsset() { throw Error("unexpected asset"); } };
  return { ctx, entries };
}
async function runImport() { const { ctx, entries } = context(); return importLegacyConversations(ctx, entries); }
beforeEach(() => { fixture = coreFixture(); sourceRoot = join(fixture.root, "snapshot"); mkdirSync(sourceRoot); });
afterEach(() => { fixture.close(); });

describe("historical room, DM and metadata-less nested topic event imports", () => {
  it("preserves full scoped event order and every model bucket across repeated import/reopen/rebuild", async () => {
    const values = [{ type: "agent_start", ts: base }, event(1, "test/model-a"), { type: "message_update", ts: base + 1, text: "retained churn" }, event(2, "test/model-a"), event(3, "test/model-b"), event(4), event(5, "  ")];
    for (const scope of scopes) events(scope, "rm_engineer", values);
    events("topic:legacy-topic", "engineer", [event(7, "test/model-a")]);
    mkdirSync(join(sourceRoot, "rooms/room-parent/topics/empty-topic"));
    write("rooms/room-parent/topics/not-a-topic.json", "{}");
    await runImport();
    for (const scope of scopes) {
      expect(readAgentEvents(scope, "legacy-unresolved:rm_engineer")).toEqual(values);
      expect(pageActivity(scope, "legacy-unresolved:rm_engineer").events).toEqual(values.filter(v => v.type !== "message_update"));
      expect(readUsageReport({ scopeId: scope }).rows.sort((a, b) => a.model.localeCompare(b.model))).toEqual([
        { room_id: scope, member_id: "legacy-unresolved:rm_engineer", date: "2026-08-01", model: "test/model-a", input_tokens: 3, output_tokens: 6, cache_read: 9, cache_write: 12, cost: 0.75, turns: 2 },
        { room_id: scope, member_id: "legacy-unresolved:rm_engineer", date: "2026-08-01", model: "test/model-b", input_tokens: 3, output_tokens: 6, cache_read: 9, cache_write: 12, cost: 0.75, turns: 1 },
        { room_id: scope, member_id: "legacy-unresolved:rm_engineer", date: "2026-08-01", model: "unknown", input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36, cost: 2.25, turns: 2 },
      ]);
    }
    expect(readUsageReport({ scopeId: "topic:legacy-topic" }).rows).toMatchObject([{ member_id: "legacy-unresolved:engineer", input_tokens: 7 }]);
    expect(fixture.db.all("SELECT id FROM rooms")).toEqual([]);
    expect(fixture.db.all("SELECT id FROM topics")).toEqual([]);
    expect(fixture.db.get("SELECT kind,room_id FROM scopes WHERE id='topic:fixture'")).toEqual({ kind: "topic", room_id: "room-parent" });
    const before = fixture.db.all("SELECT * FROM agent_events ORDER BY id");
    const usage = readUsageReport({}).rows;
    await runImport(); fixture.reopen(); await runImport(); rebuildEventAggregates();
    expect(fixture.db.all("SELECT * FROM agent_events ORDER BY id")).toEqual(before);
    expect(readUsageReport({}).rows).toEqual(usage);
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
  });
  it.each(scopes)("retains name-only and removed/unproven actors independently in %s", async scope => {
    events(scope, "engineer", [event(2)]); events(scope, "rm_removed", [event(3)]);
    await runImport();
    expect(readUsageReport({ scopeId: scope }).rows.sort((a, b) => a.member_id.localeCompare(b.member_id))).toMatchObject([
      { member_id: "legacy-unresolved:engineer", input_tokens: 2 },
      { member_id: "legacy-unresolved:rm_removed", input_tokens: 3 },
    ]);
    expect(fixture.db.all("SELECT DISTINCT member_id FROM agent_events")).toEqual([{ member_id: null }]);
  });
  it.each(scopes)("rejects an unreadable snapshotted event source in %s and retries without corrupting existing facts", async scope => {
    const file = events(scope, "rm_engineer", [event(2)]);
    const { ctx, entries } = context();
    await importLegacyConversations(ctx, entries);
    const before = fixture.db.all("SELECT * FROM agent_events");
    const body = readFileSync(file, "utf8");
    rmSync(file); mkdirSync(file);
    await expect(importLegacyConversations(ctx, entries)).rejects.toThrow("not-regular-file");
    expect(fixture.db.all("SELECT * FROM agent_events")).toEqual(before);
    rmSync(file, { recursive: true }); writeFileSync(file, body);
    await importLegacyConversations(ctx, entries);
    expect(fixture.db.all("SELECT * FROM agent_events")).toEqual(before);
    expect(readUsageReport({ scopeId: scope }).rows).toMatchObject([{ input_tokens: 2, turns: 1 }]);
  });
  it.each(["rooms", "events", "topics", "topic-events", "tasks"])("rejects unreadable %s inventory rather than certifying an empty import", source => {
    const paths: Record<string, string> = { rooms: "rooms", events: "rooms/room-parent/agent-events", topics: "rooms/room-parent/topics", "topic-events": "rooms/room-parent/topics/fixture/agent-events", tasks: "rooms/room-parent/tasks.json" };
    const path = join(sourceRoot, paths[source]); mkdirSync(dirname(path), { recursive: true });
    if (source === "tasks") mkdirSync(path); else writeFileSync(path, "not a directory");
    expect(() => discoverLegacyInventory(sourceRoot)).toThrow();
    expect(fixture.db.all("SELECT * FROM agent_events")).toEqual([]);
  });
});
