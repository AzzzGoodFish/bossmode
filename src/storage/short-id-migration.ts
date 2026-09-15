/**
 * Short-id migration (`core-short-ids-v1`) — member/room ids become
 * `mem_<nanoid10>` / `rm_<nanoid10>` (design: architecture/short-id-migration-detail-20260915.md).
 *
 * Building blocks implemented here:
 *  - mapping assignment (crypto-generated, collision-checked);
 *  - filesystem rename planning (surface roots, exclusion-aware, legacy archive
 *    segments kept, idempotent);
 *  - rename journal write / replay / apply (replayed at startup before other
 *    upgrade steps, per the review口径).
 *
 * Still to come (next slices): the DB rewrite engine (single transaction,
 * trigger DDL round-trip), self-check, and the core-startup wiring.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMmScopeId, mmScopeIdOf, parseMmScopeId } from "../shared/conversation-ref.js";
import { MEMBER_ID_PREFIX, newMemberId, newRoomId } from "../shared/short-id.js";

export const SHORT_ID_MIGRATION_ID = "core-short-ids-v1";

export interface ShortIdMapping {
  members: Map<string, string>;
  rooms: Map<string, string>;
}

export interface RenameOp {
  /** Path relative to the bossmode root, POSIX separators. */
  from: string;
  to: string;
}

// ── mapping assignment ──────────────────────────────────────────────────────

/**
 * Assign new short ids to every member and room. New ids never reuse an old id
 * or a previously assigned one (shapes cannot collide, but the invariant is
 * enforced explicitly). Callers inject generators for deterministic tests.
 */
export function assignShortIds(
  memberIds: readonly string[],
  roomIds: readonly string[],
  generate: { member?: () => string; room?: () => string } = {},
): ShortIdMapping {
  const memberGen = generate.member ?? newMemberId;
  const roomGen = generate.room ?? newRoomId;
  const taken = new Set<string>([...memberIds, ...roomIds]);
  const members = new Map<string, string>();
  const rooms = new Map<string, string>();
  for (const old of memberIds) members.set(old, reserve(memberGen, taken, "member"));
  for (const old of roomIds) rooms.set(old, reserve(roomGen, taken, "room"));
  return { members, rooms };
}

function reserve(gen: () => string, taken: Set<string>, kind: string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = gen();
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`short-id generation kept colliding for ${kind}`);
}

// ── filesystem rename planning ──────────────────────────────────────────────

const SURFACE_ROOTS = ["members", "rooms", "mcp", "pi-agent"] as const;
const SKIP_DIR_NAMES = new Set([".migration-snapshots", "backups", "node_modules", ".git"]);
const SKIP_DIR_RE = /^migration-backup-/;
const SKIP_FILE_RE = /^members\.json$|\.pre-[^.]*$/;

/**
 * Pure: compute the renamed form of a single path segment, or null to leave it.
 * Only ids present in the mapping are touched, so legacy `rm_<uuid>` records and
 * unrelated names never match.
 */
export function renameSegment(name: string, mapping: ShortIdMapping): string | null {
  const member = mapping.members.get(name);
  if (member) return member;
  const room = mapping.rooms.get(name);
  if (room) return room;
  if (name.startsWith("dm:")) {
    const inner = mapping.members.get(name.slice(3));
    return inner ? `dm:${inner}` : null;
  }
  if (isMmScopeId(name)) {
    const pair = parseMmScopeId(name);
    if (!pair) return null; // malformed pair — leave for review
    const [a, b] = pair;
    const nextA = mapping.members.get(a);
    const nextB = mapping.members.get(b);
    if (!nextA || !nextB) return null;
    return mmScopeIdOf(nextA, nextB); // canonical order may flip with new ids
  }
  if (name.startsWith(MEMBER_ID_PREFIX)) {
    // File-name forms: `mem_<id>.jsonl`, `mem_<id>.stats.json`.
    const dot = name.indexOf(".");
    if (dot > 0) {
      const next = mapping.members.get(name.slice(0, dot));
      if (next) return next + name.slice(dot);
    }
  }
  if (name.startsWith("room_")) {
    const inner = mapping.rooms.get(name.slice(5));
    if (inner) return `room_${inner}`;
  }
  return null;
}

/**
 * Plan every filesystem rename under the surface roots. Post-order: a directory's
 * own rename is recorded after its children's, so executing ops in order keeps
 * every recorded path valid until the moment it is applied.
 */
export function planFilesystemRenames(root: string, mapping: ShortIdMapping): RenameOp[] {
  const ops: RenameOp[] = [];
  // A room segment may already carry its new id (replay/second pass) — accept both.
  const roomSegments = new Set<string>([...mapping.rooms.keys(), ...mapping.rooms.values()]);
  const walk = (absDir: string, rel: string[]): void => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && (SKIP_DIR_NAMES.has(entry.name) || SKIP_DIR_RE.test(entry.name))) continue;
      if (entry.isFile() && SKIP_FILE_RE.test(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs, [...rel, entry.name]);
      // Legacy room principle trees (`rooms/<room>/memory/members/<member>/`) keep
      // their member-name segments — archive semantics (review口径 #4).
      if (rel.length === 4 && rel[0] === "rooms" && roomSegments.has(rel[1]!) && rel[2] === "memory" && rel[3] === "members" && entry.isDirectory()) continue;
      const next = renameSegment(entry.name, mapping);
      if (next && next !== entry.name) ops.push({ from: [...rel, entry.name].join("/"), to: [...rel, next].join("/") });
    }
  };
  for (const top of SURFACE_ROOTS) walk(join(root, top), [top]);
  return ops;
}

// ── rename execution + journal ──────────────────────────────────────────────

export interface RenameApplyResult {
  done: number;
  skipped: number;
  failures: string[];
}

export function applyRenameOps(root: string, ops: readonly RenameOp[]): RenameApplyResult {
  const result: RenameApplyResult = { done: 0, skipped: 0, failures: [] };
  for (const op of ops) {
    const from = join(root, op.from);
    const to = join(root, op.to);
    const fromExists = existsSync(from);
    const toExists = existsSync(to);
    if (fromExists && !toExists) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      result.done++;
    } else if (!fromExists && toExists) {
      result.skipped++; // already applied by a previous run
    } else if (fromExists && toExists) {
      result.failures.push(`target exists: ${op.to}`);
    } else {
      result.failures.push(`source missing: ${op.from}`);
    }
  }
  return result;
}

export function shortIdJournalPath(root: string): string {
  return join(root, "migrations", `${SHORT_ID_MIGRATION_ID}.journal.json`);
}

export interface ShortIdJournal {
  version: 1;
  migration: typeof SHORT_ID_MIGRATION_ID;
  createdAt: number;
  ops: RenameOp[];
}

/** Atomic write (temp + rename) so a crash never leaves a torn journal. */
export function writeShortIdJournal(root: string, ops: readonly RenameOp[]): string {
  const path = shortIdJournalPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const journal: ShortIdJournal = { version: 1, migration: SHORT_ID_MIGRATION_ID, createdAt: Date.now(), ops: [...ops] };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2));
  renameSync(tmp, path);
  return path;
}

export function readShortIdJournal(root: string): ShortIdJournal | null {
  const path = shortIdJournalPath(root);
  if (!existsSync(path)) return null;
  const journal = JSON.parse(readFileSync(path, "utf-8")) as ShortIdJournal;
  if (journal.version !== 1 || journal.migration !== SHORT_ID_MIGRATION_ID || !Array.isArray(journal.ops)) {
    throw new Error(`Unreadable ${SHORT_ID_MIGRATION_ID} journal`);
  }
  return journal;
}

export function clearShortIdJournal(root: string): void {
  rmSync(shortIdJournalPath(root), { force: true });
}

/**
 * Startup replay: finish any renames a previously interrupted run left pending.
 * Runs before the other upgrade steps so every later step sees consistent names.
 */
export function replayShortIdJournal(root: string):
  | { status: "none" }
  | { status: "replayed"; done: number; skipped: number }
  | { status: "failed"; failures: string[] } {
  const journal = readShortIdJournal(root);
  if (!journal) return { status: "none" };
  const result = applyRenameOps(root, journal.ops);
  if (result.failures.length > 0) return { status: "failed", failures: result.failures };
  clearShortIdJournal(root);
  return { status: "replayed", done: result.done, skipped: result.skipped };
}
