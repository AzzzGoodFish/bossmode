import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "./helpers/core-fixture.js";
import { importLegacyConversations } from "../src/app/upgrade/conversations.js";
import { discoverLegacyInventory, type LegacySourceEntry, type UpgradeImportContext } from "../src/app/upgrade/inventory.js";
import { loadEventsFromDisk, readStats } from "../src/agent/events.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function setup() {
  const fixture = coreFixture();
  fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_history", "History", "history", "general", "{}", 1, 1,
  );
  return fixture;
}

function source(fixture: ReturnType<typeof coreFixture>, name: string, events: object[]): LegacySourceEntry {
  const root = join(fixture.root, "snapshot");
  const path = `rooms/rm_history/agent-events/${name}.jsonl`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  return discoverLegacyInventory(root).entries.find(entry => entry.path === path)!;
}

function context(fixture: ReturnType<typeof coreFixture>, entries: LegacySourceEntry[]): UpgradeImportContext {
  return {
    db: fixture.db,
    root: fixture.root,
    sourceRoot: join(fixture.root, "snapshot"),
    previousDatabase: undefined,
    sourceFiles: entries.map(entry => entry.path),
    legacy: true,
    progress() {},
    stageAsset() { throw new Error("unexpected asset"); },
  };
}

function evidence(manifest: Map<string, string[]>) {
  return {
    eventOwner: () => ({ ownerKey: "legacy-owner", memberId: "mem_history" }),
    eventProvenance: (entry: LegacySourceEntry, ordinal: number) => manifest.get(entry.path)?.[ordinal - 1],
  };
}

describe("historical event import v2", () => {
  it("merges overlapping source order, keeps logical source identity, and replays idempotently", async () => {
    const fixture = setup();
    const start100 = { type: "agent_start", ts: 100 };
    const start50 = { type: "agent_start", ts: 50 };
    const end120 = { type: "agent_end", ts: 120 };
    const first = source(fixture, "first", [start100, start50]);
    const second = source(fixture, "second", [start50, end120]);
    const entries = [first, second];
    const options = evidence(new Map([[first.path, ["a", "b"]], [second.path, ["b", "c"]]]));

    await importLegacyConversations(context(fixture, entries), entries, options);

    const rows = fixture.db.all<any>(`SELECT historical_source_key,historical_owner_key,historical_seq,member_seq,payload_json
      FROM agent_events ORDER BY historical_seq`);
    expect(rows.map(row => row.historical_source_key)).toEqual(["rm_history", "rm_history", "rm_history"]);
    expect(rows.map(row => row.historical_seq)).toEqual([1, 2, 3]);
    expect(rows.map(row => row.member_seq)).toEqual([1, 2, 3]);
    expect(rows.map(row => JSON.parse(row.payload_json))).toEqual([start100, start50, end120]);
    expect(loadEventsFromDisk("room:rm_history", "mem_history")).toEqual([start100, start50, end120]);
    expect(readStats("mem_history").activeMs).toBe(70);

    const before = JSON.stringify(fixture.db.all("SELECT * FROM agent_events ORDER BY historical_seq"));
    await importLegacyConversations(context(fixture, entries), [...entries].reverse(), options);
    expect(JSON.stringify(fixture.db.all("SELECT * FROM agent_events ORDER BY historical_seq"))).toBe(before);
  });

  it("rejects contradictory proven source order atomically", async () => {
    const fixture = setup();
    const one = { type: "system", text: "one" };
    const two = { type: "system", text: "two" };
    const first = source(fixture, "first", [one, two]);
    const second = source(fixture, "second", [two, one]);
    const entries = [first, second];
    const options = evidence(new Map([[first.path, ["one", "two"]], [second.path, ["two", "one"]]]));

    await expect(importLegacyConversations(context(fixture, entries), entries, options))
      .rejects.toThrow("Conflicting imported event source order");
    expect(fixture.db.get<{count:number}>("SELECT COUNT(*) count FROM agent_events")!.count).toBe(0);
    expect(fixture.db.get<{count:number}>("SELECT COUNT(*) count FROM event_source_receipts WHERE source_key<>''")!.count).toBe(0);
  });
});
