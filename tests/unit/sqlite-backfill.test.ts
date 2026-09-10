import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory } from "../../src/storage/legacy-inventory.js";
import { importLegacyConversations } from "../../src/storage/upgrade-conversations.js";
import type { UpgradeImportContext } from "../../src/storage/upgrade-runner.js";
import { TasksRepository } from "../../src/storage/repositories/tasks.js";
import { readUsageReport } from "../../src/storage/usage-repository.js";
import { readStats, rebuildEventAggregates } from "../../src/storage/event-repository.js";

let fixture: ReturnType<typeof coreFixture>;
let sourceRoot: string;
beforeEach(() => { fixture = coreFixture(); sourceRoot = join(fixture.root, "snapshot"); mkdirSync(sourceRoot); });
afterEach(() => { fixture.close(); });
function file(path: string, data: string) {
  const target = join(sourceRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data);
}
function events(stem: string, values: object[]) { file(`rooms/room/agent-events/${stem}.jsonl`, values.map(v => JSON.stringify(v)).join("\n") + "\n"); }
async function runImport() {
  const entries = discoverLegacyInventory(sourceRoot).entries;
  const ctx: UpgradeImportContext = { db: fixture.db, root: fixture.root, sourceRoot, previousDatabase: undefined, sourceFiles: entries.map(e => e.path), legacy: true, progress() {}, stageAsset() { throw Error("unexpected asset"); } };
  return importLegacyConversations(ctx, entries);
}
const base = Date.parse("2026-07-24T00:00:00Z");
const end = (n: number, model?: string) => ({ type: "message_end", ts: base + n, ...(model === undefined ? {} : { model }), usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n * 0.25 } });

describe("strict historical event and task imports, not projection backfill", () => {
  it("retains unproven overlapping name and ID sources rather than guessing a historical identity", async () => {
    file("rooms/room/room.json", JSON.stringify({ id: "room", name: "room", members: ["architect"], roomMembers: [{ id: "rm_old", roomId: "room", name: "architect", sourceAgent: "general", createdAt: 1, updatedAt: 1 }], createdAt: 1 }));
    events("architect", [end(100), end(100)]);
    events("rm_old", [end(100), end(100), end(100)]);
    await runImport();
    expect(fixture.db.all("SELECT owner_key,member_id,COUNT(*) n FROM agent_events GROUP BY owner_key ORDER BY owner_key")).toEqual([
      { owner_key: "legacy-unresolved:architect", member_id: null, n: 2 },
      { owner_key: "legacy-unresolved:rm_old", member_id: null, n: 3 },
    ]);
    expect(fixture.db.get("SELECT SUM(input_tokens) input,SUM(turns) turns FROM token_usage_daily")).toEqual({ input: 500, turns: 5 });
  });
  it("retains name-only source usage as unresolved even when a current member reuses the label", async () => {
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_new','pm','pm','general','{}',1,1)");
    events("pm", [end(42)]);
    await runImport();
    expect(readUsageReport({}).rows).toMatchObject([{ member_id: "legacy-unresolved:pm", input_tokens: 42 }]);
    expect(readUsageReport({ memberId: "mem_new" }).rows).toEqual([]);
  });
  it("replays identical source IDs idempotently across reopen and aggregate rebuild without deleting facts", async () => {
    events("historical", [{ type: "agent_start", ts: base }, end(10), end(20), { type: "agent_end", ts: base + 1000 }]);
    file("rooms/room/agent-events/historical.stats.json", "invalid retired derived cache");
    await runImport();
    const before = readUsageReport({}).rows;
    const stats = readStats("room", "legacy-unresolved:historical");
    expect(stats).toEqual({ turns: 1, toolCalls: 0, activeMs: 1000, tokens: { input: 30, output: 60, cacheRead: 90, cacheWrite: 120 }, cost: 7.5, updatedAt: base + 1000 });
    await runImport(); fixture.reopen(); await runImport(); rebuildEventAggregates(); rebuildEventAggregates();
    expect(readUsageReport({}).rows).toEqual(before);
    expect(fixture.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 4 });
    expect(readStats("room", "legacy-unresolved:historical")).toEqual(stats);
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
  });
  it("imports task ownership from its source path, preserving missing/stale embedded IDs and full comments", async () => {
    file("rooms/room/room.json", JSON.stringify({ id: "room", name: "room", members: [], createdAt: 1 }));
    const common = { title: "Activity", status: "todo", priority: "P1", assignee: "old-label", createdBy: "historic", createdAt: 1, updatedAt: 2, comments: [{ id: "c1", author: "old-label", content: "literal", createdAt: 1 }] };
    file("rooms/room/tasks.json", JSON.stringify([{ ...common, id: "missing" }, { ...common, id: "stale", roomId: "other" }]));
    await runImport();
    expect(new TasksRepository().list("room")).toMatchObject([{ ...common, id: "missing", roomId: "room" }, { ...common, id: "stale", roomId: "room" }]);
    expect(new TasksRepository().list("other")).toEqual([]);
  });
  it("preserves known, omitted and blank model buckets and every usage dimension", async () => {
    events("historical", [end(100, "p/m"), end(50, "p/m"), end(20), end(10, "  ")]);
    await runImport();
    const rows = readUsageReport({ from: "2026-07-24", to: "2026-07-24", scopeId: "room" }).rows.sort((a, b) => a.model.localeCompare(b.model));
    expect(rows).toEqual([
      { room_id: "room", member_id: "legacy-unresolved:historical", date: "2026-07-24", model: "p/m", input_tokens: 150, output_tokens: 300, cache_read: 450, cache_write: 600, cost: 37.5, turns: 2 },
      { room_id: "room", member_id: "legacy-unresolved:historical", date: "2026-07-24", model: "unknown", input_tokens: 30, output_tokens: 60, cache_read: 90, cache_write: 120, cost: 7.5, turns: 2 },
    ]);
    expect(readUsageReport({ model: "unknown" }).rows).toEqual([rows[1]]);
    expect(readUsageReport({ from: "2026-07-25" }).rows).toEqual([]);
    expect(readUsageReport({ to: "2026-07-23" }).rows).toEqual([]);
  });
});
