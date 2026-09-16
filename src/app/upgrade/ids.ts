import { newMemberId, newRoomId, MEMBER_ID_PREFIX } from "../../kernel/ids.js";
import { join, dirname } from "node:path";
import { isMmScopeId, mmScopeIdOf, parseMmScopeId } from "../../chat/conversation-ref.js";
import { readdirSync, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { logger } from "../../kernel/logger.js";
import { inspectDatabase, type Database } from "../../data/database.js";

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
  if (name.startsWith("room-")) {
    const inner = mapping.rooms.get(name.slice(5));
    if (inner) return `room-${inner}`;
  }
  // Substring forms inside longer names (`mainline-room-<id>.md`, fold products
  // `scopes-room-<id>-…`) — mirrors the string-side rewrite.
  let out = name;
  for (const [old, next] of mapping.rooms) {
    if (out.includes(`room-${old}`)) out = out.split(`room-${old}`).join(`room-${next}`);
    if (out.includes(`room_${old}`)) out = out.split(`room_${old}`).join(`room_${next}`);
  }
  if (out !== name) return out;
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

/** Fold every segment of a relative path through the mapping (ancestor renames included).
 * Positionally aligned with the planner: the member segment directly under
 * `rooms/<room>/memory/members/` keeps its old form (archive semantics, design §3.3);
 * deeper segments fold as usual (`mem_<id>.jsonl` file names included). */
export function foldRelPath(rel: string, mapping: ShortIdMapping): string {
  const segments = rel.split("/");
  const roomSegments = new Set([...mapping.rooms.keys(), ...mapping.rooms.values()]);
  const keepMemberSegment = segments.length >= 5 && segments[0] === "rooms" && roomSegments.has(segments[1]!) && segments[2] === "memory" && segments[3] === "members";
  return segments
    .map((segment, index) => (keepMemberSegment && index === 4 ? segment : renameSegment(segment, mapping) ?? segment))
    .join("/");
}

export interface RenameApplyResult {
  done: number;
  skipped: number;
  failures: string[];
}

export function applyRenameOps(
  root: string,
  ops: readonly RenameOp[],
  options: { fold?: (rel: string) => string } = {},
): RenameApplyResult {
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
    } else if (!fromExists && !toExists && options.fold && existsSync(join(root, options.fold(op.to)))) {
      // Nested op whose parent was renamed afterwards (crash before the journal was
      // cleared): from/to were both recorded under the old parent name; the file
      // exists at the folded (final) location, so the op is already applied.
      result.skipped++;
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
 *
 * `mappingProvider` resolves the id mapping when available; it is only needed for
 * nested ops whose parent was already renamed (both recorded paths point under
 * the old parent name) — the op is then recognized via its folded final location.
 */
export function replayShortIdJournal(
  root: string,
  mappingProvider?: () => ShortIdMapping | null,
):
  | { status: "none" }
  | { status: "replayed"; done: number; skipped: number }
  | { status: "failed"; failures: string[] } {
  const journal = readShortIdJournal(root);
  if (!journal) return { status: "none" };
  const mapping = mappingProvider ? mappingProvider() : null;
  const result = applyRenameOps(root, journal.ops, mapping ? { fold: (rel) => foldRelPath(rel, mapping) } : {});
  if (result.failures.length > 0) return { status: "failed", failures: result.failures };
  clearShortIdJournal(root);
  return { status: "replayed", done: result.done, skipped: result.skipped };
}

/**
 * Earliest-possible replay, before any startup verifier inspects the filesystem:
 * the DB rewrite commits before the filesystem renames, so a crash between them
 * leaves new ids in SQL against old names on disk — `verifyActiveMemberAssets`
 * would reject the store before the ordinary post-upgrade steps could run.
 * Reads the mapping straight from the on-disk database (read-only).
 */
export function replayShortIdJournalFromDisk(root: string):
  | { status: "none" }
  | { status: "stale" }
  | { status: "replayed"; done: number; skipped: number }
  | { status: "failed"; failures: string[] } {
  if (!readShortIdJournal(root)) return { status: "none" };
  const probe = probeMappingFromDisk(root);
  if (probe.kind === "empty") {
    // The journal is written before the rewrite transaction and renames only run after
    // it commits, so an empty mapping means the run died pre-commit: nothing was
    // renamed, the journal is stale, and the ordinary flow re-plans from scratch.
    clearShortIdJournal(root);
    logger.info("storage-upgrade", "Cleared stale short-id rename journal (rewrite never committed)");
    return { status: "stale" };
  }
  return replayShortIdJournal(root, probe.kind === "mapping" ? () => probe.mapping : undefined);
}

type MappingProbe =
  | { kind: "mapping"; mapping: ShortIdMapping }
  | { kind: "empty" }
  | { kind: "unavailable" };

function probeMappingFromDisk(root: string): MappingProbe {
  const dbPath = join(root, "bossmode.db");
  if (!existsSync(dbPath)) return { kind: "unavailable" };
  try {
    return inspectDatabase<MappingProbe>(dbPath,raw=>{
      const rows=raw.all<{kind:string;old_id:string;new_id:string}>("SELECT kind, old_id, new_id FROM id_migration_map");
      if(rows.length===0)return {kind:"empty"};
      const members=new Map<string,string>(),rooms=new Map<string,string>();
      for(const row of rows)(row.kind==="member"?members:rooms).set(row.old_id,row.new_id);
      return {kind:"mapping",mapping:{members,rooms}};
    });
  } catch {
    return {kind:"unavailable"}; // Missing table or unreadable DB: replay still runs in strict mode.
  }
}

// ── DB rewrite engine ──────────────────────────────────────────────────────

type RewriteMode = "member" | "room" | "scope" | "composite" | "json";

interface ColumnRewrite {
  table: string;
  column: string;
  mode: RewriteMode;
}

/**
 * The column surface from the migration design (§2.1). Defensive: entries whose
 * table or column is absent on a given database are skipped silently.
 */
const COLUMN_REWRITES: readonly ColumnRewrite[] = [
  { table: "messages", column: "scope_id", mode: "scope" },
  { table: "messages", column: "sender_member_id", mode: "member" },
  { table: "message_mentions", column: "scope_id", mode: "scope" },
  { table: "message_mentions", column: "value", mode: "member" },
  { table: "message_replies", column: "scope_id", mode: "scope" },
  { table: "message_archives", column: "scope_id", mode: "scope" },
  { table: "message_archive_entries", column: "scope_id", mode: "scope" },
  { table: "scope_sequences", column: "scope_id", mode: "scope" },
  { table: "read_cursors", column: "scope_id", mode: "scope" },
  { table: "read_cursors", column: "actor_key", mode: "member" },
  { table: "user_cursor_messages", column: "scope_id", mode: "scope" },
  { table: "dm_member_cursor_sequences", column: "scope_id", mode: "scope" },
  { table: "delivery_captures", column: "scope_id", mode: "scope" },
  { table: "delivery_captures", column: "snapshot_json", mode: "json" },
  { table: "captured_deliveries", column: "scope_id", mode: "scope" },
  { table: "captured_deliveries", column: "target_actor_key", mode: "member" },
  { table: "captured_deliveries", column: "target_member_id", mode: "member" },
  { table: "queued_inputs", column: "scope_id", mode: "scope" },
  { table: "queued_inputs", column: "target_actor_key", mode: "member" },
  { table: "queued_inputs", column: "payload_json", mode: "json" },
  { table: "outbox", column: "scope_id", mode: "scope" },
  { table: "outbox", column: "dedupe_key", mode: "composite" },
  { table: "outbox", column: "payload_json", mode: "json" },
  { table: "reply_obligations", column: "scope_id", mode: "scope" },
  { table: "reply_obligations", column: "actor_key", mode: "member" },
  { table: "reply_obligations", column: "member_id", mode: "member" },
  { table: "reply_obligation_dispositions", column: "scope_id", mode: "scope" },
  { table: "reply_obligation_dispositions", column: "actor_key", mode: "member" },
  { table: "reply_settlements", column: "scope_id", mode: "scope" },
  { table: "reply_settlements", column: "actor_key", mode: "member" },
  { table: "agent_events", column: "scope_id", mode: "scope" },
  { table: "agent_events", column: "member_id", mode: "member" },
  { table: "agent_events", column: "owner_key", mode: "member" },
  { table: "current_sessions", column: "member_id", mode: "member" },
  { table: "current_sessions", column: "scope_id", mode: "scope" },
  { table: "runtime_checkpoints", column: "member_id", mode: "member" },
  { table: "runtime_checkpoints", column: "scope_id", mode: "scope" },
  { table: "runtime_stale_fields", column: "member_id", mode: "member" },
  { table: "runtime_stale_fields", column: "scope_id", mode: "scope" },
  { table: "execution_attempts", column: "member_id", mode: "member" },
  { table: "execution_attempts", column: "scope_id", mode: "scope" },
  { table: "member_statistics", column: "scope_id", mode: "scope" },
  { table: "member_statistics", column: "owner_key", mode: "member" },
  { table: "token_usage_daily", column: "member_id", mode: "member" },
  { table: "token_usage_daily", column: "room_id", mode: "scope" },
  { table: "ingest_watermark", column: "member_id", mode: "member" },
  { table: "ingest_watermark", column: "room_id", mode: "scope" },
  { table: "ssh_credentials", column: "member_id", mode: "member" },
  { table: "ssh_credentials", column: "public_key", mode: "composite" },
  { table: "workspace_registries", column: "member_id", mode: "member" },
  { table: "workspaces", column: "member_id", mode: "member" },
  { table: "workspaces", column: "root", mode: "composite" },
  { table: "mcp_config", column: "owner_id", mode: "composite" },
  { table: "mcp_servers", column: "owner_id", mode: "composite" },
  { table: "memory_documents", column: "path", mode: "composite" },
  { table: "memory_documents", column: "member_id", mode: "member" },
  { table: "memory_documents", column: "updated_by_member_id", mode: "member" },
  { table: "memory_documents", column: "scope_id", mode: "scope" },
  { table: "memory_document_history", column: "document_path", mode: "composite" },
  { table: "memory_document_history", column: "scope_id", mode: "scope" },
  { table: "memory_document_history", column: "actor_member_id", mode: "member" },
  { table: "memory_document_history", column: "snapshot_path", mode: "composite" },
  { table: "member_archive_intents", column: "member_id", mode: "member" },
  { table: "member_archive_intents", column: "source_path", mode: "composite" },
  { table: "member_archives", column: "member_id", mode: "member" },
  { table: "rooms", column: "leader_member_id", mode: "member" },
  { table: "rooms", column: "leader_global_member_id", mode: "member" },
  { table: "room_members", column: "room_id", mode: "room" },
  { table: "room_members", column: "member_id", mode: "member" },
  { table: "room_member_labels", column: "room_id", mode: "room" },
  { table: "room_member_snapshots", column: "room_id", mode: "room" },
  { table: "room_member_overrides", column: "room_id", mode: "room" },
  { table: "room_rule_docs", column: "room_id", mode: "room" },
  { table: "topics", column: "room_id", mode: "room" },
];

const SINGLE_MEMBER_KEYS = new Set([
  "senderMemberId", "targetMemberId", "memberId", "actorKey", "senderActorKey", "targetActorKey",
  "fromMemberId", "toMemberId", "ownerKey", "sourceOwnerKey", "assigneeMemberId",
]);

const MEMBER_LIST_KEYS = new Set(["mentionMemberIds", "needResponseMemberIds", "targetMemberIds", "memberIds", "subscriberMemberIds"]);

const SCOPE_KEYS = new Set(["scopeId", "scope_id", "sourceScopeId"]);

const ROOM_KEYS = new Set(["roomId", "room_id"]);

const COMPOSITE_KEYS = new Set(["path", "root"]);

function mapScopeValue(value: string, mapping: ShortIdMapping): string | null {
  if (value.startsWith("dm:")) {
    const next = mapping.members.get(value.slice(3));
    return next ? `dm:${next}` : null;
  }
  if (isMmScopeId(value)) {
    const pair = parseMmScopeId(value);
    if (!pair) return null;
    const nextA = mapping.members.get(pair[0]);
    const nextB = mapping.members.get(pair[1]);
    return nextA && nextB ? mmScopeIdOf(nextA, nextB) : null;
  }
  return mapping.rooms.get(value) ?? null;
}

/** Rebuild `mm:` pairs canonically before substring replacement (order may flip). */
function mapMmTokens(value: string, mapping: ShortIdMapping): string {
  let out = "";
  let index = 0;
  for (;;) {
    const at = value.indexOf("mm:", index);
    if (at < 0) { out += value.slice(index); break; }
    out += value.slice(index, at);
    let end = at + 3;
    while (end < value.length && /[0-9a-z_-]/.test(value[end]!)) end++;
    const token = value.slice(at + 3, end);
    const pair = parseMmScopeId(`mm:${token}`);
    if (pair) {
      const nextA = mapping.members.get(pair[0]);
      const nextB = mapping.members.get(pair[1]);
      out += nextA && nextB ? mmScopeIdOf(nextA, nextB) : `mm:${token}`;
    } else {
      out += `mm:${token}`;
    }
    index = end;
  }
  return out;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (character) => "\\" + character);

/** Structured string replacement for composite values (paths, keys, comments). */
export function mapCompositeString(value: string, mapping: ShortIdMapping): string {
  let out = mapMmTokens(value, mapping);
  for (const [old, next] of mapping.members) {
    if (!out.includes(old)) continue;
    // A member id directly following `memory/members/` is a legacy room-tree
    // segment: those keep the old form (archive semantics, design §3.3) — mirrors
    // the filesystem walker, which never renames those segments.
    out = out.replace(new RegExp(`(?<!memory/members/)${escapeRegExp(old)}`, "g"), next);
  }
  for (const [old, next] of mapping.rooms) {
    if (out.includes(`rooms/${old}`)) out = out.split(`rooms/${old}`).join(`rooms/${next}`);
    if (out.includes(`room-${old}`)) out = out.split(`room-${old}`).join(`room-${next}`);
    if (out.includes(`room_${old}`)) out = out.split(`room_${old}`).join(`room_${next}`);
    if (out.includes(`:${old}:`)) out = out.split(`:${old}:`).join(`:${next}:`);
  }
  return out;
}

const LEGACY_UNRESOLVED_PREFIX = "legacy-unresolved:";

/** Exact member-id mapping, including the quarantined `legacy-unresolved:<id>` key form. */
function mapMemberValue(value: string, mapping: ShortIdMapping): string {
  const direct = mapping.members.get(value);
  if (direct) return direct;
  if (value.startsWith(LEGACY_UNRESOLVED_PREFIX)) {
    const inner = mapping.members.get(value.slice(LEGACY_UNRESOLVED_PREFIX.length));
    if (inner) return `${LEGACY_UNRESOLVED_PREFIX}${inner}`;
  }
  return value;
}

function containsOldId(value: string, mapping: ShortIdMapping): boolean {
  // A generated new id can itself contain a legacy id as a substring when the legacy
  // id is short (e.g. `mem_a` inside `mem_agx4g1idiv`) — that is the replacement, not
  // a residue. Mask new-shaped tokens before the substring checks.
  const masked = value.replace(/mem_[0-9a-z]{10}/g, "\u0000").replace(/rm_[0-9a-z]{10}/g, "\u0000");
  for (const old of mapping.members.keys()) if (masked.includes(old)) return true;
  for (const old of mapping.rooms.keys()) {
    if (masked.includes(`rooms/${old}`) || masked.includes(`room-${old}`) || masked.includes(`room_${old}`)) return true;
  }
  return false;
}

/** Composite residue under the same keep rule as the rewrite: member segments of
 * legacy room memory trees (`memory/members/<id>`) stay old by design. */
function compositeResidual(value: string, mapping: ShortIdMapping): boolean {
  return containsOldId(value.replace(/(?<=memory\/members\/)[^/]+/g, ""), mapping);
}

function compositeResidualCount(tx: Database, table: string, column: string, mapping: ShortIdMapping): number {
  const rows = tx.all<{ v: string }>(`SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`);
  let count = 0;
  for (const row of rows) if (compositeResidual(row.v, mapping)) count++;
  return count;
}

const isOldMemberId = (value: string): boolean => /mem_[0-9a-f]{8}-[0-9a-f]{4}-/.test(value);

const isOldRoomUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** Residual old ids under the known transform keys only (content fields are exempt). */
function jsonResidual(text: string, mapping: ShortIdMapping): boolean {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return false; }
  let residual = false;
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === "string") {
      if (key && SINGLE_MEMBER_KEYS.has(key)) { if (mapping.members.has(value)) residual = true; }
      else if (key && MEMBER_LIST_KEYS.has(key)) { if (mapping.members.has(value)) residual = true; }
      else if (key && SCOPE_KEYS.has(key)) { if (isOldMemberId(value) || /^[0-9a-f]{8}-/.test(value)) residual = true; }
      else if (key && ROOM_KEYS.has(key)) { if (isOldRoomUuid(value)) residual = true; }
      else if (key && COMPOSITE_KEYS.has(key)) {
        if (isOldMemberId(value) || /rooms\/[0-9a-f]{8}-/.test(value) || /room-[0-9a-f]{8}-/.test(value)) residual = true;
      }
      return;
    }
    if (Array.isArray(value)) { for (const element of value) walk(element, key); return; }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(data, null);
  return residual;
}

function jsonResidualCount(tx: Database, table: string, column: string, mapping: ShortIdMapping): number {
  const rows = tx.all<{ v: string }>(`SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`);
  let count = 0;
  for (const row of rows) if (jsonResidual(row.v, mapping)) count++;
  return count;
}

interface JsonTransformResult { changed: boolean; text: string; parseFailure: boolean; leftovers: number }

/**
 * Structured replacement on known keys only — senderMemberId / mentionMemberIds /
 * targets' actorKey·memberId / scope strings / paths. Content fields are never
 * rewritten; strings that still carry old ids are counted, not touched.
 */
export function transformJsonText(text: string, mapping: ShortIdMapping): JsonTransformResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { changed: false, text, parseFailure: true, leftovers: 0 }; }
  let leftovers = 0;
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") {
      if (key && SINGLE_MEMBER_KEYS.has(key)) {
        const next = mapMemberValue(value, mapping);
        if (next !== value) return next;
      } else if (key && SCOPE_KEYS.has(key)) {
        const next = mapScopeValue(value, mapping);
        if (next) return next;
        const composite = mapCompositeString(value, mapping);
        if (composite !== value) return composite;
      } else if (key && ROOM_KEYS.has(key)) {
        const next = mapping.rooms.get(value);
        if (next) return next;
      } else if (key && COMPOSITE_KEYS.has(key)) {
        return mapCompositeString(value, mapping);
      }
      if (containsOldId(value, mapping)) leftovers++;
      return value;
    }
    if (Array.isArray(value)) {
      if (key && MEMBER_LIST_KEYS.has(key)) {
        return value.map((element) => (typeof element === "string" ? mapMemberValue(element, mapping) : walk(element, key)));
      }
      return value.map((element) => walk(element, key));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  const next = walk(data, null);
  const nextText = JSON.stringify(next);
  return { changed: nextText !== text, text: nextText, parseFailure: false, leftovers };
}

// ── mapping persistence ────────────────────────────────────────────────────

export function loadShortIdMapping(db: Database): ShortIdMapping | null {
  let rows: Array<{ kind: string; old_id: string; new_id: string }>;
  try {
    rows = db.all<{ kind: string; old_id: string; new_id: string }>("SELECT kind, old_id, new_id FROM id_migration_map");
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const members = new Map<string, string>();
  const rooms = new Map<string, string>();
  for (const row of rows) (row.kind === "member" ? members : rooms).set(row.old_id, row.new_id);
  return { members, rooms };
}

function loadOrAssignMapping(db: Database): ShortIdMapping {
  const existing = loadShortIdMapping(db);
  if (existing) return existing;
  const memberIds = db.all<{ id: string }>("SELECT id FROM members").map((row) => row.id);
  const roomIds = db.all<{ id: string }>("SELECT id FROM rooms").map((row) => row.id);
  return assignShortIds(memberIds, roomIds);
}

function persistMapping(tx: Database, mapping: ShortIdMapping): void {
  const ts = Date.now();
  for (const [oldId, newId] of mapping.members) tx.run("INSERT OR IGNORE INTO id_migration_map(kind, old_id, new_id, ts) VALUES('member', ?, ?, ?)", oldId, newId, ts);
  for (const [oldId, newId] of mapping.rooms) tx.run("INSERT OR IGNORE INTO id_migration_map(kind, old_id, new_id, ts) VALUES('room', ?, ?, ?)", oldId, newId, ts);
}

function writeMappingMirror(root: string, mapping: ShortIdMapping): void {
  const dir = join(root, "archive", "id-migration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SHORT_ID_MIGRATION_ID}.json`), JSON.stringify({
    migration: SHORT_ID_MIGRATION_ID,
    generatedAt: new Date().toISOString(),
    members: Object.fromEntries(mapping.members),
    rooms: Object.fromEntries(mapping.rooms),
  }, null, 2));
}

// ── rewrite passes ─────────────────────────────────────────────────────────

function makeAccessors(db: Database) {
  const tables = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
  const columns = new Map<string, Set<string>>();
  return {
    hasTable: (table: string) => tables.has(table),
    hasColumn: (table: string, column: string) => {
      let set = columns.get(table);
      if (!set) {
        set = new Set(db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name));
        columns.set(table, set);
      }
      return set.has(column);
    },
  };
}

function rewriteRootEntities(tx: Database, mapping: ShortIdMapping): void {
  for (const [oldId, newId] of mapping.members) tx.run("UPDATE members SET id=? WHERE id=?", newId, oldId);
  for (const [oldId, newId] of mapping.rooms) tx.run("UPDATE rooms SET id=? WHERE id=?", newId, oldId);
  const rows = tx.all<{ r: number; id: string; kind: string; room_id: string | null; member_id: string | null }>(
    "SELECT rowid AS r, id, kind, room_id, member_id FROM scopes",
  );
  for (const row of rows) {
    let nextId = row.id;
    let nextRoom = row.room_id;
    let nextMember = row.member_id;
    if (row.kind === "room" && row.room_id) {
      nextRoom = mapping.rooms.get(row.room_id) ?? row.room_id;
      nextId = nextRoom;
    } else if (row.kind === "topic" && row.room_id) {
      nextRoom = mapping.rooms.get(row.room_id) ?? row.room_id;
    } else if (row.kind === "dm" && row.member_id) {
      nextMember = mapping.members.get(row.member_id) ?? row.member_id;
      nextId = `dm:${nextMember}`;
    } else if (row.kind === "mm" && row.member_id) {
      const pair = row.member_id.split("|");
      if (pair.length === 2) {
        const a = mapping.members.get(pair[0]!) ?? pair[0]!;
        const b = mapping.members.get(pair[1]!) ?? pair[1]!;
        const [x, y] = a < b ? [a, b] : [b, a];
        nextMember = `${x}|${y}`;
        nextId = mmScopeIdOf(x, y);
      }
    }
    if (nextId !== row.id || nextRoom !== row.room_id || nextMember !== row.member_id) {
      tx.run("UPDATE scopes SET id=?, room_id=?, member_id=? WHERE rowid=?", nextId, nextRoom, nextMember, row.r);
    }
  }
}

function rewriteColumns(tx: Database, mapping: ShortIdMapping, stats: { jsonParseFailures: number }): void {
  const accessors = makeAccessors(tx);
  for (const { table, column, mode } of COLUMN_REWRITES) {
    if (!accessors.hasTable(table) || !accessors.hasColumn(table, column)) continue;
    if (mode === "json") {
      const rows = tx.all<{ r: number; v: string }>(`SELECT rowid AS r, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`);
      for (const row of rows) {
        const result = transformJsonText(row.v, mapping);
        if (result.parseFailure) { stats.jsonParseFailures++; continue; }
        if (result.changed) tx.run(`UPDATE "${table}" SET "${column}"=? WHERE rowid=?`, result.text, row.r);
      }
      continue;
    }
    const transform =
      mode === "member" ? (value: string) => mapMemberValue(value, mapping)
        : mode === "room" ? (value: string) => mapping.rooms.get(value) ?? value
          : mode === "scope" ? (value: string) => mapScopeValue(value, mapping) ?? value
            : (value: string) => mapCompositeString(value, mapping);
    const values = tx.all<{ v: string }>(`SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`).map((row) => row.v);
    for (const value of values) {
      const next = transform(value);
      if (next !== value) tx.run(`UPDATE "${table}" SET "${column}"=? WHERE "${column}"=?`, next, value);
    }
  }
}

function rewriteLegacyEventLedgers(tx: Database, mapping: ShortIdMapping, stats: { jsonParseFailures: number }): void {
  const rows = tx.all<{ r: number; v: string }>(
    "SELECT rowid AS r, value AS v FROM storage_meta WHERE key LIKE 'legacy-event-occurrence-v1:%'",
  );
  for (const row of rows) {
    const result = transformJsonText(row.v, mapping);
    if (result.parseFailure) { stats.jsonParseFailures++; continue; }
    if (result.changed) tx.run("UPDATE storage_meta SET value=? WHERE rowid=?", result.text, row.r);
  }
}

const EXCLUDED_PATH_SEGMENTS = new Set(["backups", ".migration-snapshots"]);

const EXCLUDED_FILE_RE = /^(members\.json|.*\.pre-[^.]*)$/;

/** Exclusion zones from the migration design: their disk names keep the old ids. */
export function isExcludedRelPath(rel: string): boolean {
  const segments = rel.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (EXCLUDED_PATH_SEGMENTS.has(segment) || segment.startsWith("migration-backup-")) return true;
    if (index === segments.length - 1 && EXCLUDED_FILE_RE.test(segment)) return true;
  }
  return false;
}

function rewriteUpgradeFilePaths(tx: Database, mapping: ShortIdMapping): void {
  // Every live ledger path follows its renamed file (hash unchanged; backup_path keeps
  // the exclusion-listed old value). Pending-retirement rows (retire=1, retired_at NULL)
  // must keep resolving so the retirement pass can still find their sources. Paths that
  // point into exclusion zones (backups etc.) keep the old ids — the disk names there
  // never change, so the ledger must stay paired with them.
  const rows = tx.all<{ r: number; p: string }>("SELECT rowid AS r, path AS p FROM storage_upgrade_files");
  for (const row of rows) {
    if (isExcludedRelPath(row.p)) continue;
    const next = mapCompositeString(row.p, mapping);
    if (next !== row.p) tx.run("UPDATE storage_upgrade_files SET path=? WHERE rowid=?", next, row.r);
  }
}

function snapshotTriggers(tx: Database): Array<{ name: string; sql: string }> {
  // Every trigger on a rewritten table must be dropped for the rewrite and rebuilt
  // verbatim afterwards (immutability/guard triggers on deliveries, inputs and reply
  // bookkeeping all abort direct updates).
  const tables = [...new Set([...COLUMN_REWRITES.map((entry) => entry.table), "scopes", "members", "rooms"])];
  const placeholders = tables.map(() => "?").join(",");
  return tx.all<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`,
    ...tables,
  );
}

const UUID_LIKE = "'________-____-____-____-____________'";

/** Contains an old-format member id: `mem_` + exactly 8 hex chars + `-`. New nanoid
 *  ids are 10 chars before any separator, so they can never match. */
const OLD_MEMBER_GLOB = "'*mem_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*'";

function checkNoOldIds(tx: Database, mapping: ShortIdMapping): string[] {
  const failures: string[] = [];
  const accessors = makeAccessors(tx);
  for (const { table, column, mode } of COLUMN_REWRITES) {
    if (!accessors.hasTable(table) || !accessors.hasColumn(table, column)) continue;
    const c = `"${column}"`;
    let count: number | undefined;
    if (mode === "member") {
      count = tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${c} IS NOT NULL AND ${c} GLOB ${OLD_MEMBER_GLOB}`)?.n;
    } else if (mode === "room") {
      count = tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${c} IS NOT NULL AND ${c} LIKE ${UUID_LIKE}`)?.n;
    } else if (mode === "scope") {
      count = tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${c} IS NOT NULL AND (${c} GLOB ${OLD_MEMBER_GLOB} OR ${c} LIKE ${UUID_LIKE})`)?.n;
    } else if (mode === "composite") {
      count = compositeResidualCount(tx, table, column, mapping);
    } else {
      count = jsonResidualCount(tx, table, column, mapping);
    }
    if (count && count > 0) failures.push(`${table}.${column}: ${count}`);
  }
  const scopes = tx.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM scopes WHERE kind != 'topic' AND (id GLOB ${OLD_MEMBER_GLOB} OR id LIKE ${UUID_LIKE}`
    + ` OR member_id GLOB ${OLD_MEMBER_GLOB} OR room_id LIKE ${UUID_LIKE})`,
  )?.n;
  if (scopes && scopes > 0) failures.push(`scopes: ${scopes}`);
  const ledgerRows = tx.all<{ v: string }>(
    "SELECT value AS v FROM storage_meta WHERE key LIKE 'legacy-event-occurrence-v1:%' AND value IS NOT NULL",
  );
  let ledgerResidual = 0;
  for (const row of ledgerRows) if (jsonResidual(row.v, mapping)) ledgerResidual++;
  if (ledgerResidual > 0) failures.push(`storage_meta.ledger: ${ledgerResidual}`);
  return failures;
}

export interface ShortIdMigrationReport {
  status: "already-done" | "migrated";
  members: number;
  rooms: number;
  filesRenamed: number;
  jsonParseFailures: number;
}

/**
 * The one-shot migration: plan + journal the filesystem renames, then the
 * single-transaction DB rewrite (mapping fill, root ids, column surface, ledgers,
 * trigger round-trip, FK + residue self-check), then apply the renames, then the
 * archive mirror and done flag. Journal-before-commit makes the crash windows
 * self-healing: a journal without a committed mapping is stale and gets cleared.
 * Any failure throws — startup must not continue on a half-migrated store.
 */
export function migrateShortIds(root: string, db: Database): ShortIdMigrationReport {
  if (db.get("SELECT 1 FROM storage_meta WHERE key=?", SHORT_ID_MIGRATION_ID)) {
    return { status: "already-done", members: 0, rooms: 0, filesRenamed: 0, jsonParseFailures: 0 };
  }
  const mapping = loadOrAssignMapping(db);
  const stats = { jsonParseFailures: 0 };
  // Plan and journal BEFORE the rewrite transaction; renames only run after it
  // commits, so a journal with no committed mapping is always stale (see replay).
  const ops = planFilesystemRenames(root, mapping);
  if (ops.length > 0) writeShortIdJournal(root, ops);
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction((tx) => {
      persistMapping(tx, mapping);
      const triggers = snapshotTriggers(tx);
      for (const trigger of triggers) tx.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      rewriteRootEntities(tx, mapping);
      rewriteColumns(tx, mapping, stats);
      rewriteLegacyEventLedgers(tx, mapping, stats);
      rewriteUpgradeFilePaths(tx, mapping);
      for (const trigger of triggers) tx.exec(trigger.sql); // verbatim DDL round-trip
      if (tx.get("PRAGMA foreign_key_check")) throw new Error("Short-id migration left foreign key violations");
      const residue = checkNoOldIds(tx, mapping);
      if (residue.length > 0) throw new Error(`Short-id rewrite incomplete: ${residue.join(", ")}`);
    });
  } catch (error) {
    if (ops.length > 0) clearShortIdJournal(root); // rewrite rolled back: the pre-commit plan is stale
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  let filesRenamed = 0;
  if (ops.length > 0) {
    const result = applyRenameOps(root, ops, { fold: (rel) => foldRelPath(rel, mapping) });
    if (result.failures.length > 0) {
      throw new Error(`Short-id filesystem rename failed (journal kept for replay): ${result.failures.slice(0, 5).join("; ")}`);
    }
    clearShortIdJournal(root);
    filesRenamed = result.done;
  }
  writeMappingMirror(root, mapping);
  db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SHORT_ID_MIGRATION_ID,
    JSON.stringify({ members: mapping.members.size, rooms: mapping.rooms.size, filesRenamed, jsonParseFailures: stats.jsonParseFailures, completedAt: Date.now() }));
  logger.info("storage-upgrade", "Short ids migrated", { members: mapping.members.size, rooms: mapping.rooms.size, filesRenamed, jsonParseFailures: stats.jsonParseFailures });
  return { status: "migrated", members: mapping.members.size, rooms: mapping.rooms.size, filesRenamed, jsonParseFailures: stats.jsonParseFailures };
}
