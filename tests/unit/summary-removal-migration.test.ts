/**
 * summary-removal-v1 migration — deletes derived summary rows from
 * messages.jsonl (covered originals all remain), snapshot + idempotent.
 * Legacy fixture mirrors pre-0.19 rooms: summary rows interleaved with the
 * original messages they covered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory } from "../../src/data/upgrade/legacy-inventory.js";
import { importLegacyConversations } from "../../src/data/upgrade/upgrade-conversations.js";
let dir: string;
let sequence: number;
let fixture: ReturnType<typeof coreFixture>;

async function importHistoricalMessages() {
  const entries = discoverLegacyInventory(dir).entries.filter(e => e.kind === "messages");
  await importLegacyConversations({ db: fixture.db, root: dir, sourceRoot: dir,
    previousDatabase: undefined, sourceFiles: entries.map(e => e.path), legacy: true,
    progress() {}, stageAsset() { throw new Error("unexpected asset"); },
  }, entries);
}

function line(sender: string, content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id: `msg-${++sequence}`, seq: sequence, sender, content, mentions: [], ts: Date.now(), ...extra });
}

function seedRoom(roomId: string, lines: string[]) {
  const roomDir = join(dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(join(roomDir, "messages.jsonl"), lines.join("\n") + "\n", "utf-8");
}

function readRoomLines(roomId: string): any[] {
  const content = readFileSync(join(dir, "rooms", roomId, "messages.jsonl"), "utf-8");
  return content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe("summary-removal-v1 migration", () => {
  beforeEach(() => {
    fixture = coreFixture();
    dir = fixture.root;
    sequence = 0;
    mkdirSync(join(dir, "rooms"), { recursive: true });
  });

  afterEach(() => {
    fixture.close();
  });

  it("removes summary rows, originals reappear in place, snapshot written, idempotent rerun", async () => {
    const summaryRow = JSON.stringify({
      id: "msg-sum1", sender: "system", content: "[Summary] covered stuff", mentions: [], ts: Date.now(),
      type: "summary",
      summary_meta: {
        title: "s", covered_range: { from_id: "x", to_id: "y", count: 2 },
        time_range: { from: 1, to: 2 }, participants: ["user", "pm"],
      },
    });
    seedRoom("room-a", [
      line("user", "ORIGINAL-1"),
      line("pm", "ORIGINAL-2"),
      summaryRow,
      line("user", "ORIGINAL-3", { type: "task_event" }),
    ]);
    seedRoom("room-b", [line("user", "NO-SUMMARY-HERE")]);

    const { runSummaryRemovalMigration } = await import("../../src/chat/migrations/summary-removal-migration.js");
    const result = runSummaryRemovalMigration();
    expect(result).toEqual({ rooms: 1, removed: 1, skipped: false });

    const messages = readRoomLines("room-a");
    expect(messages.map((m) => m.content)).toEqual(["ORIGINAL-1", "ORIGINAL-2", "ORIGINAL-3"]);
    expect(messages.some((m) => m.type === "summary")).toBe(false);
    // typed non-summary rows are preserved
    expect(messages[2].type).toBe("task_event");
    // untouched room left alone
    expect(readRoomLines("room-b").map((m) => m.content)).toEqual(["NO-SUMMARY-HERE"]);

    // snapshot of the pre-migration file (with the summary row) exists
    const snapshot = join(dir, "pi-agent", "runtime", ".migration-snapshots", "room-a-messages-summary-removal-v1.jsonl");
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot, "utf-8")).toContain("msg-sum1");

    // marker recorded
    const marker = JSON.parse(readFileSync(join(dir, "pi-agent", "runtime", ".migrations", "summary-removal-v1.json"), "utf-8"));
    expect(marker.rooms["room-a"].removed).toBe(1);

    // rerun: no-op, file unchanged
    const before = readFileSync(join(dir, "rooms", "room-a", "messages.jsonl"), "utf-8");
    const rerun = runSummaryRemovalMigration();
    expect(rerun).toEqual({ rooms: 0, removed: 0, skipped: true });
    expect(readFileSync(join(dir, "rooms", "room-a", "messages.jsonl"), "utf-8")).toBe(before);
    await importHistoricalMessages();
    const { getMessages } = await import("../../src/chat/message-store.js");
    expect(getMessages("room-a").map(m => m.content)).toEqual(["ORIGINAL-1", "ORIGINAL-2", "ORIGINAL-3"]);
    expect(getMessages("room-a")[2].type).toBe("task_event");
    expect(getMessages("room-b").map(m => m.content)).toEqual(["NO-SUMMARY-HERE"]);
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("after explicit historical import, SQL readers return originals without summary merging", async () => {
    seedRoom("room-c", [
      line("user", "PLAIN-1"),
      line("pm", "PLAIN-2"),
    ]);
    await importHistoricalMessages();
    const store = await import("../../src/chat/message-store.js");
    const messages = store.getMessages("room-c", { limit: 50 });
    expect(messages.map((m) => m.content)).toEqual(["PLAIN-1", "PLAIN-2"]);
  });
});
