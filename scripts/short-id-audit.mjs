#!/usr/bin/env node
/**
 * Short-id migration drill — phase 1: pre-migration audit (read-only).
 *
 * Inventories every place member/room ids live, in both the SQLite store and the
 * filesystem, and produces a machine-readable baseline that later phases check
 * against (migrated DBs must preserve every count with old ids swapped for new).
 *
 * Usage:
 *   node scripts/short-id-audit.mjs --bossmode-dir <absolute dir> [--snapshot-from <live.db>] [--output <report.json>] [--assert-clean]
 *
 * - Never writes to the audited database (opens it read-only).
 * - --snapshot-from: take a consistent online snapshot of a live DB into
 *   <bossmode-dir>/bossmode.db first (sqlite backup API), then audit the snapshot.
 *   Use this when the source service is still running (WAL file present).
 * - --assert-clean (post-migration verification): fail if old-shaped member/scope
 *   traces remain on the migration surface (outside the exclusion list and the
 *   legacy keep zones: archive/** and rooms/<room>/memory/members/**).
 */
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const bossmodeDir = option("--bossmode-dir");
const snapshotFrom = option("--snapshot-from");
const outputFile = option("--output");
const assertClean = argv.includes("--assert-clean");
if (!bossmodeDir || !bossmodeDir.startsWith("/") || !existsSync(bossmodeDir)) {
  console.error("Usage: node scripts/short-id-audit.mjs --bossmode-dir <absolute existing dir> [--snapshot-from <live.db>] [--output <report.json>] [--assert-clean]");
  process.exit(1);
}

const dbPath = join(bossmodeDir, "bossmode.db");
if (snapshotFrom) {
  if (!existsSync(snapshotFrom)) { console.error(`snapshot source missing: ${snapshotFrom}`); process.exit(1); }
  if (existsSync(dbPath)) { console.error(`refusing to overwrite existing ${dbPath} — remove it or audit it directly`); process.exit(1); }
  const source = new DatabaseSync(snapshotFrom, { readOnly: true });
  await backup(source, dbPath);
  source.close();
  console.log(`snapshot: ${snapshotFrom} -> ${dbPath}`);
}
if (!existsSync(dbPath)) { console.error(`no database at ${dbPath} (pass --snapshot-from to create one)`); process.exit(1); }

// ── id shape classifiers (single source for both DB and FS passes) ──────────
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const reMemberOld = new RegExp(`^mem_${UUID}$`);
const reMemberNano = /^mem_[0-9a-z]{10}$/;
const reMemberAny = /^mem_/;
const reBareUuid = new RegExp(`^${UUID}$`);
const reRmOld = new RegExp(`^rm_${UUID}$`);
const reRmAny = /^rm_/;
const reRoomPrefix = /^room_/;
const classify = (value) => {
  if (typeof value !== "string" || value.length === 0) return null;
  if (reMemberOld.test(value)) return "member_old";
  if (reMemberNano.test(value)) return "member_nano";
  if (value.startsWith("dm:")) {
    const rest = value.slice(3);
    if (reMemberOld.test(rest)) return "dm_scope_old";
    if (reMemberNano.test(rest)) return "dm_scope_new";
    return "dm_scope_other";
  }
  if (value.startsWith("mm:")) {
    const rest = value.slice(3);
    if (/mem_[0-9a-f]{8}-/.test(rest)) return "mm_scope_old";
    if (/^mem_[0-9a-z]{10}-mem_[0-9a-z]{10}$/.test(rest)) return "mm_scope_new";
    return "mm_scope_other";
  }
  if (value.startsWith("room:")) return "room_scope";
  if (reBareUuid.test(value)) return "uuid_bare";
  if (reRmOld.test(value)) return "rm_old_record";
  if (reRmAny.test(value)) return "rm_other";
  if (reRoomPrefix.test(value)) return "room_prefix";
  if (reMemberAny.test(value)) {
    // File-name forms: `mem_<id>.jsonl`, `mem_<id>.stats.json` — classify the stem.
    const stem = value.includes(".") ? value.slice(0, value.indexOf(".")) : value;
    if (stem !== value && reMemberOld.test(stem)) return "member_old_file";
    if (stem !== value && reMemberNano.test(stem)) return "member_nano_file";
    return "member_other";
  }
  return null;
};

// SQL approximations for the same shapes (index-friendly, one scan per column).
// GLOB (not LIKE): `_` must stay literal — LIKE treats it as a single-char wildcard
// and "member" / "mentionMemberIds" would false-match `mem_`.
const COLUMN_PATTERNS = [
  ["member_old", (c) => `${c} GLOB 'mem_*-*'`],
  ["member_any", (c) => `${c} GLOB 'mem_*'`],
  ["contains_mem", (c) => `${c} GLOB '*mem_*'`],
  ["dm_scope", (c) => `${c} GLOB 'dm:*'`],
  ["mm_scope", (c) => `${c} GLOB 'mm:*'`],
  ["room_scope", (c) => `${c} GLOB 'room:*'`],
  ["rm_any", (c) => `${c} GLOB 'rm_*'`],
  ["uuid_bare", (c) => `${c} LIKE '________-____-____-____-____________'`],
];

const report = {
  meta: {
    script: "short-id-audit",
    generatedAt: new Date().toISOString(),
    bossmodeDir,
    database: dbPath,
    node: process.version,
  },
  checks: {},
  tables: [],
  filesystem: {},
  warnings: [],
};

// ── database pass ───────────────────────────────────────────────────────────
const db = new DatabaseSync(dbPath, { readOnly: true });
const identifier = (name) => `"${String(name).replaceAll('"', '""')}"`;

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
report.checks.tableCount = tables.length;

const BIG_TABLE_ROWS = 20000;
const BIG_TEXT_DENY = new Set(["content", "content_lower"]);
const ID_ISH = /(scope|member|actor|owner|sender|leader|target|id|key|path|value)/i;

for (const table of tables) {
  const columns = db.prepare(`PRAGMA table_info(${identifier(table)})`).all()
    .filter((c) => /TEXT/i.test(c.type) || c.type === "")
    .map((c) => c.name);
  if (columns.length === 0) continue;
  const { rows } = db.prepare(`SELECT COUNT(*) AS rows FROM ${identifier(table)}`).get();
  const big = rows > BIG_TABLE_ROWS;
  const candidates = columns.filter((c) => {
    if (BIG_TEXT_DENY.has(c)) return false;
    return big ? ID_ISH.test(c) : true;
  });
  const tableReport = { table, rows, columns: [] };
  for (const column of candidates) {
    const col = identifier(column);
    const sums = COLUMN_PATTERNS
      .map(([name, build]) => `SUM(CASE WHEN ${build(col)} THEN 1 ELSE 0 END) AS "${name}"`)
      .join(", ");
    let row;
    try {
      row = db.prepare(`SELECT COUNT(*) AS total, ${sums} FROM ${identifier(table)} WHERE ${col} IS NOT NULL`).get();
    } catch (cause) {
      report.warnings.push(`scan failed: ${table}.${column}: ${String(cause)}`);
      continue;
    }
    const matches = {};
    for (const [name] of COLUMN_PATTERNS) if (row[name] > 0) matches[name] = row[name];
    if (Object.keys(matches).length === 0) continue;
    const samples = {};
    for (const [name, build] of COLUMN_PATTERNS) {
      if (!matches[name]) continue;
      const sampleRows = db.prepare(`SELECT DISTINCT ${col} AS v FROM ${identifier(table)} WHERE ${build(col)} LIMIT 4`).all();
      samples[name] = sampleRows.map((r) => classify(r.v) ?? "(composite)").map((k, i) => ({ shape: k, value: String(sampleRows[i].v).slice(0, 120) }));
    }
    tableReport.columns.push({ column, matches, samples });
  }
  if (tableReport.columns.length > 0) report.tables.push(tableReport);
}

// ── curated integrity checks ────────────────────────────────────────────────
try {
  report.checks.members = db.prepare("SELECT COUNT(*) AS n, SUM(id GLOB 'mem_*-*') AS old_shape, SUM(id GLOB 'mem_*' AND NOT id GLOB 'mem_*-*') AS nano_shape FROM members").get();
  report.checks.rooms = db.prepare("SELECT COUNT(*) AS n, SUM(id LIKE '________-____-____-____-____________') AS uuid_shape FROM rooms").get();
  report.checks.scopesByKind = db.prepare("SELECT kind, COUNT(*) AS n FROM scopes GROUP BY kind ORDER BY kind").all();
  report.checks.scopes = db.prepare(`
    SELECT SUM(id GLOB 'dm:*') AS dm, SUM(id GLOB 'mm:*') AS mm,
           SUM(NOT id GLOB 'dm:*' AND NOT id GLOB 'mm:*') AS room_or_other,
           SUM(member_id IS NOT NULL) AS with_member
    FROM scopes`).get();
  report.checks.dmScopesMissingMember = db.prepare("SELECT COUNT(*) AS n FROM scopes s WHERE s.kind='dm' AND s.member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = s.member_id)").get().n;
  report.checks.roomsMissingScope = db.prepare("SELECT COUNT(*) AS n FROM rooms r WHERE NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = r.id)").get().n;
  report.checks.messages = db.prepare(`
    SELECT COUNT(*) AS n, SUM(scope_id GLOB 'dm:*') AS dm, SUM(scope_id GLOB 'mm:*') AS mm,
           SUM(sender_member_id IS NOT NULL) AS with_sender_id, COUNT(DISTINCT sender_member_id) AS distinct_senders
    FROM messages`).get();
  report.checks.messageMentions = db.prepare("SELECT value_kind, COUNT(*) AS n FROM message_mentions GROUP BY value_kind").all();
  report.checks.mentionIdOld = db.prepare("SELECT COUNT(*) AS n FROM message_mentions WHERE value_kind='id' AND value GLOB 'mem_*'").get().n;
  report.checks.readCursors = db.prepare("SELECT COUNT(*) AS n, SUM(actor_key GLOB 'mem_*') AS member_keys, SUM(NOT actor_key GLOB 'mem_*') AS other_keys FROM read_cursors").get();
} catch (cause) {
  report.warnings.push(`curated checks failed: ${String(cause)}`);
}
db.close();

// ── filesystem pass ─────────────────────────────────────────────────────────
const SKIP_NAMES = new Set(["node_modules", ".git", "extensions"]);
const SKIP_FILES = /^(bossmode\.db.*|.*\.log|.*\.pid)$/;
// Four zones: surface (migration targets) / excluded (rollback & backup artifacts
// that keep old ids) / library (documentation trees with no migration surface) /
// archive (the global archive tree — historical, keeps old ids). The "kept" bucket
// holds expected legacy room-memory segments (archive semantics, not renamed).
const EXCLUDED_DIR_NAMES = new Set(["backups", ".migration-snapshots"]);
const EXCLUDED_DIR_RE = /^migration-backup-/;
const EXCLUDED_FILE_RE = /^members\.json$|\.pre-[^.]*$/;
const LIBRARY_TOPS = new Set(["memory"]);
// Legacy room trees rename the room directory only; member segments below
// rooms/<room>/memory/members/ stay as-is by design (archive semantics, §3.3).
const ROOM_MEMORY_KEEP = /^rooms\/[^/]+\/memory\/members\//;
let scanned = 0;
const zones = { surface: { entries: 0, byTop: {} }, excluded: { entries: 0, samples: [] }, library: { entries: 0, byTop: {} }, archive: { entries: 0, byTop: {} }, kept: { entries: 0, byTop: {} } };
const bump = (zone, top, shape, path) => {
  const bucketRoot = zones[zone];
  if (zone === "excluded") {
    bucketRoot.entries++;
    if (bucketRoot.samples.length < 10) bucketRoot.samples.push(relative(bossmodeDir, path));
    return;
  }
  bucketRoot.entries++;
  bucketRoot.byTop[top] ??= {};
  const bucket = (bucketRoot.byTop[top][shape] ??= { count: 0, samples: [] });
  bucket.count++;
  if (bucket.samples.length < 3) bucket.samples.push(relative(bossmodeDir, path));
};
function walk(dir, top, zone) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.test(entry.name)) continue;
    const path = join(dir, entry.name);
    scanned++;
    if (zone === "surface" && (EXCLUDED_DIR_NAMES.has(entry.name) || EXCLUDED_DIR_RE.test(entry.name) || (entry.isFile() && EXCLUDED_FILE_RE.test(entry.name)))) {
      bump("excluded", top, entry.isDirectory() ? "dir" : "file", path);
      continue; // excluded zones are not walked
    }
    const shape = classify(entry.name);
    const rel = relative(bossmodeDir, path).split("\\").join("/");
    if (shape && zone === "surface" && ROOM_MEMORY_KEEP.test(rel)) bump("kept", top, shape, path);
    else if (shape) bump(zone, top, shape, path);
    else if (entry.isDirectory()) bump(zone, top, "dir", path);
    if (entry.isDirectory()) {
      if (statSync(path, { throwIfNoEntry: false })?.isSymbolicLink?.()) continue;
      walk(path, top, zone);
    }
  }
}
for (const top of readdirSync(bossmodeDir, { withFileTypes: true })) {
  if (!top.isDirectory()) continue;
  if (SKIP_NAMES.has(top.name)) continue;
  const zone = top.name === "archive" ? "archive" : LIBRARY_TOPS.has(top.name) ? "library" : "surface";
  walk(join(bossmodeDir, top.name), top.name, zone);
}
report.filesystem = { scannedEntries: scanned, ...zones };

// Post-migration assertion: no old-shaped member/scope traces outside the exclusion
// list, the archive tree, and the legacy room-memory keep zones.
const ASSERT_VIOLATION_SHAPES = new Set(["member_old", "member_old_file", "member_other", "dm_scope_old", "dm_scope_other", "mm_scope_old", "mm_scope_other"]);
if (assertClean) {
  const violations = [];
  for (const [top, shapes] of Object.entries(zones.surface.byTop)) {
    for (const [shape, bucket] of Object.entries(shapes)) {
      if (!ASSERT_VIOLATION_SHAPES.has(shape)) continue;
      for (const sample of bucket.samples) violations.push(`${shape} ${sample}`);
    }
  }
  if (violations.length > 0) {
    console.error(`assert-clean FAILED — ${violations.length} old-shaped trace(s) on the migration surface:`);
    for (const v of violations.slice(0, 20)) console.error(`  ${v}`);
    process.exitCode = 2;
  } else {
    console.log("assert-clean: no old-shaped member/scope traces outside exclusions and keep zones (archive, legacy room memory)");
  }
}

// ── output ──────────────────────────────────────────────────────────────────
const summary = [];
summary.push(`db tables: ${report.checks.tableCount}`);
summary.push(`members: ${JSON.stringify(report.checks.members)}`);
summary.push(`rooms: ${JSON.stringify(report.checks.rooms)}`);
summary.push(`scopes: ${JSON.stringify(report.checks.scopes)}`);
const dbHits = report.tables.reduce((n, t) => n + t.columns.length, 0);
summary.push(`db tables with id-shaped values: ${report.tables.length} (${dbHits} columns)`);
for (const t of report.tables) {
  const cols = t.columns.map((c) => `${c.column}{${Object.keys(c.matches).join(",")}}`).join(" ");
  summary.push(`  ${t.table} (rows=${t.rows}): ${cols}`);
}
summary.push(`fs scanned entries: ${scanned} (surface ${zones.surface.entries} / excluded ${zones.excluded.entries} / library ${zones.library.entries} / archive ${zones.archive.entries} / kept ${zones.kept.entries})`);
for (const [zoneName, zone] of [["surface", zones.surface], ["library", zones.library], ["archive", zones.archive], ["kept", zones.kept]]) {
  for (const [top, shapes] of Object.entries(zone.byTop)) {
    const line = Object.entries(shapes).filter(([s]) => s !== "dir").map(([s, v]) => `${s}:${v.count}`).join(" ");
    if (line) summary.push(`  [${zoneName}] ${top}/: ${line}`);
  }
}
console.log(summary.join("\n"));

if (outputFile) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(report, null, 2));
  console.log(`report: ${outputFile}`);
}
