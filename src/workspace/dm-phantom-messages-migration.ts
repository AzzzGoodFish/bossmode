// Migration: dm-phantom-messages-v1
// Before scope-routed postMessage (0.20.0-rc.5), shared code paths called
// postMessage with a DM conversation address ("dm:<memberId>"), which wrote a
// phantom rooms/dm:<memberId>/messages.jsonl that neither the UI nor members
// could read. This sweep merges any such phantom messages into the member-owned
// DM store (dm-messages.jsonl, re-sequenced in original order), snapshots the
// phantom file, and removes it. Idempotent by data state: no phantom file →
// no work, no marker needed. (rooms/dm:<id>/agent-events stays — instance
// activity artifacts are re-keyed in a later storage-convergence batch.)
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import type { RoomMessage } from "../shared/types.js";
import { addDmMessage } from "./dm-message-store.js";

function roomsRoot(): string {
  return join(getBossmodeDir(), "rooms");
}

function snapshotRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime", ".migration-snapshots", "dm-phantom-messages-v1");
}

export function runDmPhantomMessagesMigration(): void {
  const root = roomsRoot();
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("dm:")) continue;
    const memberId = entry.name.slice("dm:".length);
    if (!memberId) continue;
    const dir = join(root, entry.name);
    const phantomPath = join(dir, "messages.jsonl");
    if (!existsSync(phantomPath)) continue;

    const phantom = parseJsonlLines<RoomMessage>(readFileSync(phantomPath, "utf-8"), {
      category: "dm-phantom-messages-migration",
      context: { memberId },
    });
    // Snapshot before any mutation.
    const snapDir = join(snapshotRoot(), entry.name);
    mkdirSync(snapDir, { recursive: true });
    copyFileSync(phantomPath, join(snapDir, "messages.jsonl"));

    // Merge into the member-owned DM store, oldest first (new seqs assigned).
    const sorted = [...phantom].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (const m of sorted) {
      const { id: _id, seq: _seq, ts: _ts, ...rest } = m;
      addDmMessage(memberId, rest);
    }

    rmSync(phantomPath, { force: true });
    // A phantom .seq sidecar has no meaning once messages.jsonl is gone.
    rmSync(join(dir, ".seq"), { force: true });
    logger.info("migration", "dm phantom messages merged into dm store", {
      memberId,
      merged: sorted.length,
      snapshot: join(snapDir, "messages.jsonl"),
    });
  }
}
