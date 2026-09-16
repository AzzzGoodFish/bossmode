import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory, type LegacySourceEntry } from "../../src/data/upgrade/legacy-inventory.js";
import { importLegacyConversations } from "../../src/data/upgrade/upgrade-conversations.js";
import { prepareStorageUpgrade, type UpgradeImportContext } from "../../src/data/upgrade/upgrade-runner.js";
import { coreStorageMigrations } from "../../src/data/migrations.js";
import { openDatabase } from "../../src/data/database.js";
import { importAgentEvent } from "../../src/data/repositories/event-repository.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });
function write(path: string, values: object[]) {
  const file = join(fixture.root, path); mkdirSync(dirname(file), { recursive: true });
  const bytes = values.map(v => JSON.stringify(v)).join("\n") + "\n";
  writeFileSync(file, bytes); return bytes;
}
const event = (n: number) => ({ type: "message_end", ts: n, seq: 0, model: "p/m", usage: { inputTokens: n, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });

it("rejects late conflicting event proof without publishing any facts/receipts, then retries automatic cutover and reopen", async () => {
  const first = "rooms/room/agent-events/old-label.jsonl";
  const second = "rooms/room/agent-events/mem_one.jsonl";
  const values = Array.from({ length: 130 }, (_, i) => event(i));
  const firstBytes = write(first, values);
  const badBytes = write(second, [...values.slice(0, -1), event(999)]);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('retained','room','retained')");
  importAgentEvent(fixture.db, { id: "authoritative", scopeId: "retained", ownerKey: "retained", memberId: null, seq: 7, ts: 0, event: event(0) });
  const retained = fixture.db.all("SELECT * FROM agent_events");
  fixture.db.close();
  let entries: LegacySourceEntry[] = [];
  const proofManifest = new Map([first, second].map(path => [path, values.map((_, i) => `execution/event-${i}`)]));
  const options = {
    root: fixture.root, formatVersion: 1, migrations: coreStorageMigrations,
    collectLegacySources: async () => (entries = discoverLegacyInventory(fixture.root).entries),
    importData: async (ctx: UpgradeImportContext) => { await importLegacyConversations(ctx, entries, {
      eventOwner: entry => {
        if (!proofManifest.has(entry.path)) throw Error("unproven actor source");
        return { ownerKey: "historically-proven-actor", memberId: null };
      },
      eventProvenance: (entry, ordinal) => proofManifest.get(entry.path)![ordinal - 1],
    }); },
    validate: async () => {},
  };
  await expect(prepareStorageUpgrade(options)).rejects.toThrow("Conflicting imported event identity");
  expect(readFileSync(join(fixture.root, first), "utf8")).toBe(firstBytes);
  expect(readFileSync(join(fixture.root, second), "utf8")).toBe(badBytes);
  for (const path of [fixture.path, join(fixture.root, "upgrades/staging.sqlite")]) {
    const db = openDatabase(path);
    try {
      expect(db.all("SELECT * FROM agent_events")).toEqual(retained);
      expect(db.get("SELECT value FROM storage_meta WHERE key='core-authority'")).toBeUndefined();
      expect(db.all("SELECT * FROM storage_meta WHERE key LIKE 'legacy-event-%'")).toEqual([]);
      expect(db.get("SELECT SUM(turns) n FROM token_usage_daily")).toEqual({ n: 1 });
    } finally { db.close(); }
  }
  write(second, values);
  const result = await prepareStorageUpgrade(options);
  const before = result.db.all("SELECT * FROM agent_events ORDER BY id");
  const receipts = result.db.all("SELECT * FROM storage_meta WHERE key LIKE 'legacy-event-%' ORDER BY key");
  try {
    expect(result.migrated).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(before).toHaveLength(131);
    expect(result.db.all("SELECT * FROM agent_events WHERE id='authoritative'")).toEqual(retained);
    expect(result.db.get("SELECT input_tokens,output_tokens,cache_read,cache_write,cost,turns FROM token_usage_daily WHERE member_id='historically-proven-actor'")).toEqual({ input_tokens: 8385, output_tokens: 0, cache_read: 0, cache_write: 0, cost: 0, turns: 130 });
    expect(receipts).toHaveLength(390); // 260 original occurrences plus 130 event-proof bindings.
    expect(result.db.all("SELECT * FROM outbox")).toEqual([]);
    for (const path of [first, second]) {
      expect(existsSync(join(fixture.root, path))).toBe(false);
      const backup = result.db.get<{ backup_path: string }>("SELECT backup_path FROM storage_upgrade_files WHERE path=?", path)!;
      expect(readFileSync(join(fixture.root, backup.backup_path), "utf8")).toBe(firstBytes);
    }
  } finally { result.db.close(); }
  const reopened = await prepareStorageUpgrade(options);
  try {
    expect(reopened.migrated).toBe(false);
    expect(reopened.db.all("SELECT * FROM agent_events ORDER BY id")).toEqual(before);
    expect(reopened.db.all("SELECT * FROM storage_meta WHERE key LIKE 'legacy-event-%' ORDER BY key")).toEqual(receipts);
  } finally { reopened.db.close(); }
});
