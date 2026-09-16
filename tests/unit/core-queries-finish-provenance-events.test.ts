import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory, type LegacySourceEntry } from "../../src/app/upgrade/inventory.js";
import { importLegacyConversations } from "../../src/app/upgrade/conversations.js";
import { type UpgradeImportContext } from "../../src/app/upgrade/inventory.js";
import { importAgentEvent, readAgentEvents, readStats, rebuildEventAggregates } from "../../src/data/repositories/event-repository.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  for (const id of ["mem_one", "mem_two"]) fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,'general','{}',1,1)", id, id, id);
});
afterEach(() => fixture.close());
const actor = { ownerKey: "mem_one", memberId: "mem_one" };
const event = (n: number) => ({ type: "message_end", ts: n, seq: 0, model: "p/m", usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n / 4 }, extra: { zero: 0, empty: "", list: [0, null, false] } });
function source(name: string, events: object[], scope = "room"): LegacySourceEntry {
  const root = join(fixture.root, "snapshot");
  const path = `rooms/${scope}/agent-events/${name}.jsonl`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), "\n" + events.map(e => JSON.stringify(e)).join("\n\n") + "\n");
  return discoverLegacyInventory(root).entries.find(e => e.path === path)!;
}
function context(entries: LegacySourceEntry[]): UpgradeImportContext {
  return { db: fixture.db, root: fixture.root, sourceRoot: join(fixture.root, "snapshot"), previousDatabase: undefined, sourceFiles: entries.map(e => e.path), legacy: true, progress() {}, stageAsset() { throw Error("unexpected asset"); } };
}
function proof(sources: Array<[LegacySourceEntry, Array<string | undefined>]>) {
  // Fixture manifest is external evidence. Never compare payloads or parse actor filenames.
  const manifest = new Map(sources.map(([entry, ids]) => [entry.path, ids]));
  return { eventOwner: () => actor, eventProvenance: (entry: LegacySourceEntry, ordinal: number) => {
    const ids = manifest.get(entry.path);
    if (!ids || ordinal > ids.length) throw Error("unproven occurrence");
    return ids[ordinal - 1];
  } };
}
function facts() { return fixture.db.all("SELECT * FROM agent_events ORDER BY scope_id,owner_key,seq"); }
function snapshot() {
  return {
    facts: facts(), receipts: fixture.db.all("SELECT * FROM storage_meta ORDER BY key"),
    usage: fixture.db.all("SELECT * FROM token_usage_daily ORDER BY room_id,member_id,date,model"),
    stats: fixture.db.all("SELECT * FROM member_statistics ORDER BY scope_id,owner_key"),
    tokens: fixture.db.all("SELECT * FROM event_usage_receipts ORDER BY event_id"),
  };
}
function provenance() {
  return fixture.db.all<{ value: string }>("SELECT value FROM storage_meta WHERE key LIKE 'legacy-event-occurrence-v1:%' ORDER BY key").map(r => JSON.parse(r.value));
}

it.each(["room", "dm:mem_one"])("allocates independent same-owner source occurrences without using payload sequence in %s", async scope => {
  const a = source("old-label", [event(0), event(0), event(2)], scope);
  const b = source("mem_one", [event(0), event(3)], scope);
  const entries = [a, b];
  await importLegacyConversations(context(entries), entries, { eventOwner: () => actor });
  expect(readAgentEvents(scope, actor.ownerKey)).toEqual([event(0), event(0), event(2), event(0), event(3)]);
  expect(facts().map(r => r.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(facts().map(r => r.id)).toEqual(entries.flatMap(e => Array.from({ length: e === a ? 3 : 2 }, (_, i) => `legacy:${createHash("sha256").update(e.path).digest("hex")}:${i + 1}`)));
  const before = snapshot();
  fixture.reopen();
  await importLegacyConversations(context(entries), [...entries].reverse(), { eventOwner: () => actor });
  expect(snapshot()).toEqual(before);
  rebuildEventAggregates();
  expect(snapshot()).toEqual(before);
  expect(provenance().map(r => [r.path, r.ordinal]).sort()).toEqual([[a.path, 1], [a.path, 2], [a.path, 3], [b.path, 1], [b.path, 2]].sort());
  expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
});

for (const subset of [[1, 2], [2], [2, 3]]) {
  for (const reverse of [false, true]) {
    it(`merges proven subset ${subset} and superset in ${reverse ? "superset-first" : "subset-first"} order, including separate imports/reopen`, async () => {
      const a = source("old-label", subset.map(event));
      const b = source("mem_one", [1, 2, 3].map(event));
      const options = proof([[a, subset.map(n => `execution/event-${n}`)], [b, [1, 2, 3].map(n => `execution/event-${n}`)]]);
      const entries = reverse ? [b, a] : [a, b];
      await importLegacyConversations(context(entries), [entries[0]], options);
      fixture.reopen();
      await importLegacyConversations(context(entries), [entries[1]], options);
      expect(readAgentEvents("room", actor.ownerKey)).toEqual([1, 2, 3].map(event));
      expect(fixture.db.get("SELECT input_tokens,output_tokens,cache_read,cache_write,cost,turns,model FROM token_usage_daily")).toEqual({ input_tokens: 6, output_tokens: 12, cache_read: 18, cache_write: 24, cost: 1.5, turns: 3, model: "p/m" });
      expect(provenance()).toHaveLength(subset.length + 3);
      expect(provenance().filter(r => r.path === a.path).sort((a, b) => a.ordinal - b.ordinal).map(r => r.proof)).toEqual(subset.map(n => `execution/event-${n}`));
      const before = snapshot();
      fixture.reopen();
      await importLegacyConversations(context(entries), [...entries].reverse(), options);
      expect(snapshot()).toEqual(before);
      rebuildEventAggregates();
      expect(snapshot()).toEqual(before);
      expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
    });
  }
}

it("retains equal independent occurrences alongside explicitly proven duplicates in one import", async () => {
  const a = source("one", [event(0), event(0), event(0)]);
  const b = source("two", [event(0), event(0)]);
  const entries = [a, b];
  await importLegacyConversations(context(entries), entries, proof([[a, ["same-event", undefined, "different-event"]], [b, ["same-event", undefined]]]));
  expect(readAgentEvents("room", actor.ownerKey)).toEqual(Array.from({ length: 4 }, () => event(0)));
  expect(provenance()).toHaveLength(5);
  expect(fixture.db.get("SELECT turns,input_tokens FROM token_usage_daily")).toEqual({ turns: 4, input_tokens: 0 });
});

it("compares JSON semantics after explicit proof, retaining first payload spelling, absent timestamps and both source timestamps", async () => {
  const payload = { type: "message_end", model: "", usage: { inputTokens: 0, cost: 0 }, nested: { a: 0, b: [false, null] } };
  const reordered = { nested: { b: [false, null], a: 0 }, usage: { cost: 0, inputTokens: 0 }, model: "", type: "message_end" };
  const a = { ...source("one", [payload]), mtimeMs: 0 };
  const b = { ...source("two", [reordered]), mtimeMs: 86400000 };
  const entries = [a, b];
  await importLegacyConversations(context(entries), entries, proof([[a, ["event"]], [b, ["event"]]]));
  expect(facts()).toHaveLength(1);
  expect(facts()[0]).toMatchObject({ ts: 0, payload_json: JSON.stringify(payload) });
  expect(provenance().map(r => r.sourceTimestamp).sort((a, b) => a - b)).toEqual([0, 86400000]);
});

it("rebuilds order-dependent statistics after inserting proven missing prefix/middle events", async () => {
  const start = { type: "agent_start", ts: 0 };
  const end = { type: "agent_end", ts: 10 };
  const a = source("subset", [end]);
  const b = source("superset", [start, event(1), end]);
  const entries = [a, b];
  const options = proof([[a, ["end"]], [b, ["start", "final", "end"]]]);
  await importLegacyConversations(context(entries), [a], options);
  await importLegacyConversations(context(entries), [b], options);
  expect(readAgentEvents("room", actor.ownerKey)).toEqual([start, event(1), end]);
  expect(readStats("room", actor.ownerKey)).toMatchObject({ turns: 1, activeMs: 10, updatedAt: 10 });
  const before = snapshot(); rebuildEventAggregates(); expect(snapshot()).toEqual(before);
});

it.each(["payload", "scope", "owner", "member", "absent-zero", "array-order"])("rolls back all event facts and provenance on conflicting %s proof", async conflict => {
  const a = source("one", [event(1)]);
  const badPayload = conflict === "payload" ? event(2) : conflict === "absent-zero" ? { ...event(1), seq: undefined } : conflict === "array-order" ? { ...event(1), extra: { ...event(1).extra, list: [false, null, 0] } } : event(1);
  const b = source("two", [event(9), badPayload], conflict === "scope" ? "other" : "room");
  const entries = [a, b];
  const options = proof([[a, ["same"]], [b, ["new", "same"]]]);
  await importLegacyConversations(context(entries), [a], options);
  const before = snapshot();
  const conflicting = { ...options, eventOwner: (entry: LegacySourceEntry) => entry.path !== b.path ? actor : { ownerKey: conflict === "owner" ? "other" : actor.ownerKey, memberId: conflict === "member" ? "mem_two" : actor.memberId } };
  await expect(importLegacyConversations(context(entries), [b], conflicting)).rejects.toThrow(/Conflicting/);
  expect(snapshot()).toEqual(before);
  expect(fixture.db.get("SELECT id FROM scopes WHERE id='other'")).toBeUndefined();
});

it("rejects contradictory source ordering instead of dropping or reversing occurrences", async () => {
  const a = source("one", [event(1), event(2)]);
  const b = source("two", [event(2), event(1)]);
  const entries = [a, b];
  const options = proof([[a, ["first", "second"]], [b, ["second", "first"]]]);
  const before = snapshot();
  await expect(importLegacyConversations(context(entries), entries, options)).rejects.toThrow(/Conflicting.*order/);
  expect(snapshot()).toEqual(before);
});

it("refuses changed or removed proof for an already imported source occurrence", async () => {
  const a = source("one", [event(1)]);
  const entries = [a];
  await importLegacyConversations(context(entries), entries, proof([[a, ["first"]]]));
  const before = snapshot(); fixture.reopen();
  for (const options of [proof([[a, ["other"]]]), { eventOwner: () => actor }]) {
    await expect(importLegacyConversations(context(entries), entries, options)).rejects.toThrow(/Conflicting/);
    expect(snapshot()).toEqual(before);
  }
});

it("does not retroactively deduplicate unproven facts when new proof is later supplied", async () => {
  const a = source("one", [event(1)]);
  const entries = [a];
  await importLegacyConversations(context(entries), entries, { eventOwner: () => actor });
  const before = snapshot();
  await expect(importLegacyConversations(context(entries), entries, proof([[a, ["event"]]]))).rejects.toThrow(/Conflicting/);
  expect(snapshot()).toEqual(before);
});

it("accepts baseline path/ordinal facts on replay without renumbering or inventing event evidence", async () => {
  const a = source("one", [event(1)]);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('room','room','room')");
  const id = `legacy:${createHash("sha256").update(a.path).digest("hex")}:1`;
  importAgentEvent(fixture.db, { id, scopeId: "room", ...actor, seq: 1, ts: 1, event: event(1) });
  const before = facts();
  await importLegacyConversations(context([a]), [a], { eventOwner: () => actor });
  expect(facts()).toEqual(before);
  expect(provenance()).toHaveLength(1);
});

it.each(["", "   ", 1, null])("rejects malformed event proof %j instead of silently treating it as absent", async invalid => {
  const a = source("one", [event(1)]);
  const before = snapshot();
  await expect(importLegacyConversations(context([a]), [a], { eventOwner: () => actor, eventProvenance: () => invalid as string })).rejects.toThrow(/Invalid.*provenance/);
  expect(snapshot()).toEqual(before);
});

it("does not treat a matching live ID without an import proof receipt as duplicate-event evidence", async () => {
  const a = source("one", [event(1)]);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('room','room','room')");
  importAgentEvent(fixture.db, { id: "legacy-proven:event", scopeId: "room", ...actor, seq: 1, ts: 1, event: event(1) });
  const before = snapshot();
  await expect(importLegacyConversations(context([a]), [a], proof([[a, ["event"]]]))).rejects.toThrow(/Conflicting/);
  expect(snapshot()).toEqual(before);
});

it("retains independent same-owner source order across the 128-row batching boundary", async () => {
  const values = Array.from({ length: 130 }, (_, i) => event(129 - i));
  const a = source("one", values);
  const b = source("two", values);
  const entries = [a, b];
  await importLegacyConversations(context(entries), entries, { eventOwner: () => actor });
  expect(readAgentEvents("room", actor.ownerKey)).toEqual([...values, ...values]);
  const before = snapshot();
  fixture.reopen();
  await importLegacyConversations(context(entries), [...entries].reverse(), { eventOwner: () => actor });
  expect(snapshot()).toEqual(before);
});

it("merges proven duplicate events with original provenance in dm:mem_one", async () => {
  const scope = "dm:mem_one";
  const a = source("one", [event(1)], scope);
  const b = source("two", [event(0), event(1)], scope);
  const entries = [a, b];
  await importLegacyConversations(context(entries), entries, proof([[a, ["end"]], [b, ["start", "end"]]]));
  expect(readAgentEvents(scope, actor.ownerKey)).toEqual([event(0), event(1)]);
  expect(provenance()).toHaveLength(3);
  expect(provenance().every(r => r.scopeId === scope && r.sourceScopeId === scope)).toBe(true);
});

it("does not infer actor aliases from proven event IDs when source owner labels disagree", async () => {
  const a = source("old-label", [event(0)]);
  const b = source("mem_one", [event(0)]);
  const entries = [a, b];
  const before = snapshot();
  await expect(importLegacyConversations(context(entries), entries, { eventProvenance: () => "same-event" })).rejects.toThrow(/Conflicting/);
  expect(snapshot()).toEqual(before);
});

it("rejects absent versus explicit zero timestamp under the same proven event ID", async () => {
  const a = source("one", [event(0)]);
  const { ts: _timestamp, ...missingTimestamp } = event(0);
  const b = source("two", [missingTimestamp]);
  const entries = [a, b];
  const before = snapshot();
  await expect(importLegacyConversations(context(entries), entries, proof([[a, ["same"]], [b, ["same"]]]))).rejects.toThrow(/Conflicting/);
  expect(snapshot()).toEqual(before);
});
