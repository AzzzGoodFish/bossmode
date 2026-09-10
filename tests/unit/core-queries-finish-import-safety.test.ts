import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory, type LegacySourceEntry } from "../../src/storage/legacy-inventory.js";
import { importLegacyConversations } from "../../src/storage/upgrade-conversations.js";
import { prepareStorageUpgrade, type UpgradeImportContext } from "../../src/storage/upgrade-runner.js";
import { coreStorageMigrations } from "../../src/storage/migrations.js";
import { openDatabase } from "../../src/storage/database.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });
function write(root: string, path: string, body: string) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file; }
const event = (n: number) => ({ type: "message_end", ts: 1000 + n, usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n * 0.25 }, model: "p/m" });
const jsonl = (values: object[]) => values.map(v => JSON.stringify(v)).join("\n") + "\n";

it.each(["room", "dm:mem_one", "topic:one"])("leaves prior DB facts and original files unchanged after a late corrupt %s event batch, then retries cutover", async scope => {
  fixture.db.exec("CREATE TABLE retained_fact(value TEXT); INSERT INTO retained_fact VALUES('authoritative')");
  const root = fixture.root;
  const path = scope.startsWith("topic:") ? "rooms/room/topics/one/agent-events/historic.jsonl" : `rooms/${scope}/agent-events/historic.jsonl`;
  const good = jsonl(Array.from({ length: 130 }, (_, i) => event(i + 1)));
  const file = write(root, path, good + "{corrupt}\n");
  fixture.db.close();
  let entries: LegacySourceEntry[] = [];
  const options = {
    root, formatVersion: 1, migrations: coreStorageMigrations,
    collectLegacySources: async () => (entries = discoverLegacyInventory(root).entries),
    importData: async (ctx: UpgradeImportContext) => { await importLegacyConversations(ctx, entries); },
    validate: async () => {},
  };
  await expect(prepareStorageUpgrade(options)).rejects.toThrow("invalid-json");
  expect(readFileSync(file, "utf8")).toBe(good + "{corrupt}\n");
  const original = openDatabase(fixture.path);
  expect(original.get("SELECT value FROM retained_fact")).toEqual({ value: "authoritative" });
  expect(original.all("SELECT * FROM agent_events")).toEqual([]);
  expect(original.all("SELECT * FROM token_usage_daily")).toEqual([]);
  expect(original.get("SELECT value FROM storage_meta WHERE key='core-authority'")).toBeUndefined();
  original.close();
  // The failed staging DB has committed its first batch; none of it was published.
  const staged = openDatabase(join(root, "upgrades/staging.sqlite"));
  expect(staged.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 128 }); staged.close();
  writeFileSync(file, good);
  const result = await prepareStorageUpgrade(options);
  expect(result.migrated).toBe(true);
  expect(result.db.get("SELECT value FROM retained_fact")).toEqual({ value: "authoritative" });
  expect(result.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 130 });
  expect(result.db.get("SELECT SUM(input_tokens) input,SUM(turns) turns FROM token_usage_daily")).toEqual({ input: 8515, turns: 130 });
  expect(result.db.all("SELECT * FROM outbox")).toEqual([]);
  expect(existsSync(file)).toBe(false);
  result.db.close();
  const again = await prepareStorageUpgrade(options);
  expect(again.migrated).toBe(false);
  expect(again.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 130 });
  again.db.close();
});

// Known importer defect, outside this PR's production allowlist. Keep the desired
// duplicate-superset contract executable, not silently replaced by current-name inference.
// Remove .fails only when the parent implements verified cross-source provenance.
it.fails("BLOCKED: imports a proven name/ID duplicate superset once without losing model/token dimensions", async () => {
  const root = join(fixture.root, "snapshot");
  write(root, "rooms/room/agent-events/old-label.jsonl", jsonl([event(1), event(2)]));
  write(root, "rooms/room/agent-events/mem_one.jsonl", jsonl([event(1), event(2), event(3)]));
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_one','new-label','new-label','general','{}',1,1)");
  const entries = discoverLegacyInventory(root).entries;
  const ctx: UpgradeImportContext = { db: fixture.db, root: fixture.root, sourceRoot: root, previousDatabase: undefined, sourceFiles: entries.map(e => e.path), legacy: true, progress() {}, stageAsset() { throw Error("unexpected asset"); } };
  // Explicit external evidence for these exact sources. Neither the filename nor
  // a current name is used to infer the historical owner.
  const verifiedSources = new Set(entries.map(e => e.path));
  let error: unknown;
  try {
    await importLegacyConversations(ctx, entries, { eventOwner: entry => {
      if (!verifiedSources.has(entry.path)) throw Error("unproven source");
      return { ownerKey: "mem_one", memberId: "mem_one" };
    } });
  } catch (caught) { error = caught; }
  // Preserve the concrete collision diagnostic in the standalone failing repro log.
  if (error && !String(error).includes("UNIQUE constraint failed: agent_events.scope_id, agent_events.owner_key, agent_events.seq")) throw error;
  expect(error, "verified duplicate source import must succeed, not collide on owner sequence").toBeUndefined();
  expect(fixture.db.get("SELECT COUNT(*) n FROM agent_events")).toEqual({ n: 3 });
  expect(fixture.db.get("SELECT input_tokens,output_tokens,cache_read,cache_write,cost,turns,model FROM token_usage_daily")).toEqual({ input_tokens: 6, output_tokens: 12, cache_read: 18, cache_write: 24, cost: 1.5, turns: 3, model: "p/m" });
});
