import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory, type LegacySourceEntry } from "../../src/data/upgrade/legacy-inventory.js";
import { importLegacyConversations } from "../../src/data/upgrade/upgrade-conversations.js";
import { prepareStorageUpgrade, type UpgradeImportContext } from "../../src/data/upgrade/upgrade-runner.js";
import { coreStorageMigrations } from "../../src/data/migrations.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });
function write(root: string, path: string, body: string) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file; }
const event = (n: number) => ({ type: "message_end", ts: 1000 + n, usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n * 0.25 }, model: "p/m" });
const jsonl = (values: object[]) => values.map(v => JSON.stringify(v)).join("\n") + "\n";

it.each(["room", "dm:mem_one"])("preserves an unreadable %s event line in SQL quarantine and imports the readable history exactly once", async scope => {
  fixture.db.exec("CREATE TABLE retained_fact(value TEXT); INSERT INTO retained_fact VALUES('authoritative')");
  const root = fixture.root;
  const path = `rooms/${scope}/agent-events/historic.jsonl`;
  const good = jsonl(Array.from({ length: 130 }, (_, i) => event(i + 1)));
  const source = good + "{corrupt}\n";
  const file = write(root, path, source);
  fixture.db.close();
  let entries: LegacySourceEntry[] = [];
  const options = {
    root, formatVersion: 1, migrations: coreStorageMigrations,
    collectLegacySources: async () => (entries = discoverLegacyInventory(root).entries),
    importData: async (ctx: UpgradeImportContext) => { await importLegacyConversations(ctx, entries); },
    validate: async () => {},
  };
  // The old runtime skipped unreadable lines; import keeps every readable execution
  // and preserves the exact skipped line instead of failing the whole upgrade.
  const result = await prepareStorageUpgrade(options);
  expect(result.migrated).toBe(true);
  expect(result.db.get("SELECT value FROM retained_fact")).toEqual({ value: "authoritative" });
  expect(result.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 130 });
  expect(result.db.get("SELECT SUM(input_tokens) input,SUM(turns) turns FROM token_usage_daily")).toEqual({ input: 8515, turns: 130 });
  expect(result.db.all("SELECT * FROM outbox")).toEqual([]);
  const quarantine = result.db.all<{ value: string }>("SELECT value FROM storage_meta WHERE key LIKE 'legacy-invalid-event-v1:%'");
  expect(quarantine).toHaveLength(1);
  const record = JSON.parse(quarantine[0].value);
  expect(record).toMatchObject({ path, ordinal: 131, reason: "invalid-json" });
  expect(Buffer.from(record.rawBase64, "base64").toString()).toBe("{corrupt}\n");
  const backup = result.db.get<{ backup_path: string }>("SELECT backup_path FROM storage_upgrade_files WHERE path=?", path)!;
  expect(readFileSync(join(root, backup.backup_path), "utf8")).toBe(source);
  expect(existsSync(file)).toBe(false);
  result.db.close();
  const again = await prepareStorageUpgrade(options);
  expect(again.migrated).toBe(false);
  expect(again.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 130 });
  expect(again.db.all("SELECT * FROM storage_meta WHERE key LIKE 'legacy-invalid-event-v1:%'")).toHaveLength(1);
  again.db.close();
});

// Actor evidence alone cannot prove that equal payloads are the same executions.
it("retains independent equal events from two proven same-owner sources", async () => {
  const root = join(fixture.root, "snapshot");
  write(root, "rooms/room/agent-events/old-label.jsonl", jsonl([event(1), event(2)]));
  write(root, "rooms/room/agent-events/mem_one.jsonl", jsonl([event(1), event(2), event(3)]));
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_one','new-label','new-label','general','{}',1,1)");
  const entries = discoverLegacyInventory(root).entries;
  const ctx: UpgradeImportContext = { db: fixture.db, root: fixture.root, sourceRoot: root, previousDatabase: undefined, sourceFiles: entries.map(e => e.path), legacy: true, progress() {}, stageAsset() { throw Error("unexpected asset"); } };
  // External actor evidence for these exact sources, NOT duplicate-event evidence.
  const verifiedSources = new Set(entries.map(e => e.path));
  await importLegacyConversations(ctx, entries, { eventOwner: entry => {
    if (!verifiedSources.has(entry.path)) throw Error("unproven source");
    return { ownerKey: "mem_one", memberId: "mem_one" };
  } });
  expect(fixture.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 5 });
  expect(fixture.db.get("SELECT input_tokens,output_tokens,cache_read,cache_write,cost,turns,model FROM token_usage_daily")).toEqual({ input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36, cost: 2.25, turns: 5, model: "p/m" });
});
