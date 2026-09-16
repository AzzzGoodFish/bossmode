// Knowledge migrations — run at server startup. All idempotent.
// ==============================================================
//
// Two historical migrations now run as a chain:
//
// 1. 0.6.x → 0.7.0: legacy `<kbId>/entries/<uuid>.json` → `<kbId>/docs/<folder>/<slug>.md`
//    Entries folder is renamed to `entries.legacy/` for safety.
//    Room `ruleIds: [uuid]` → `ruleDocs: [path]` via a uuid→path map.
//
// 2. 0.7.0 → 0.8.0: per-KB containers dissolved into a single namespace.
//    Each `<kbId>/docs/` is moved into `docs/<kbNameSlug>/`. The original
//    `<kbId>/` directory is renamed to `<kbId>.legacy/` (preserving any
//    `entries.legacy/` + `knowledge.json` backup).
//    Room `knowledgeBaseId` is deleted; `ruleDocs` paths are prefixed with
//    `<kbNameSlug>/` so they point into the new unified tree.
//
// Both migrations are safe to run multiple times. The second checks whether
// a KB directory has already been moved (rename → `.legacy`) and skips.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, cpSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getBossmodeDir } from "../config/config.js";
import { logger } from "../kernel/logger.js";
import { slugify } from "./store.js";

function knowledgeDir(): string { return join(getBossmodeDir(), "knowledge"); }
function docsRootDir(): string { return join(knowledgeDir(), "docs"); }
function roomsDir(): string { return join(getBossmodeDir(), "rooms"); }

interface LegacyEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  type?: "rule" | "knowledge";
  createdAt?: number;
  updatedAt?: number;
}

interface LegacyKBMeta {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

function buildFrontmatter(fm: Record<string, string | number>, body: string): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    const val = typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : String(v);
    lines.push(`${k}: ${val}`);
  }
  lines.push("---", "", body.trimStart());
  return lines.join("\n");
}

// ── Migration 1: entries/*.json → docs/*.md (0.6.x → 0.7.0) ──

function categorize(entry: LegacyEntry): string {
  if (entry.type === "rule") return "rules";
  const t = entry.title || "";
  if (/^implementation plan:/i.test(t)) return "implementation-plans";
  if (/^prd:/i.test(t)) return "prds";
  if (/^implementation note:/i.test(t)) return "implementation-plans";
  if (/architecture map|system cognition|tech debt|architecture overview/i.test(t)) return "architecture";
  if (/功能全景|高阶抽象/i.test(t)) return "architecture";
  if (/发布|release|changelog/i.test(t)) return "releases";
  if (/collaboration|协作|team protocol|dev team/i.test(t)) return "rules";
  if (/onboarding|test infrastructure/i.test(t)) return "qa";
  if (/bug|postmortem/i.test(t)) return "bugs";
  if (/freeu/i.test(t)) return "freeu";
  return "misc";
}

interface LegacyEntryMigrationResult {
  kbId: string;
  migrated: number;
  uuidToPath: Record<string, string>;
}

function migrateKbEntries(kbId: string): LegacyEntryMigrationResult | null {
  const kbRoot = join(knowledgeDir(), kbId);
  const legacyEntries = join(kbRoot, "entries");
  const markerPath = join(kbRoot, ".migrated");
  if (existsSync(markerPath)) return null;
  if (!existsSync(legacyEntries)) {
    writeFileSync(markerPath, String(Date.now()), "utf-8");
    return null;
  }

  const kbDocsRoot = join(kbRoot, "docs");
  mkdirSync(kbDocsRoot, { recursive: true });
  const uuidToPath: Record<string, string> = {};
  const usedPaths = new Set<string>();
  let migrated = 0;

  const files = readdirSync(legacyEntries).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const abs = join(legacyEntries, file);
    let entry: LegacyEntry;
    try { entry = JSON.parse(readFileSync(abs, "utf-8")); }
    catch (err) {
      logger.error("knowledge-migration", "parse legacy entry failed", { kbId, file, error: String(err) });
      continue;
    }
    const folder = categorize(entry);
    const baseSlug = slugify(entry.title || entry.id);
    let slug = baseSlug;
    let candidate = `${folder}/${slug}.md`;
    let n = 2;
    while (usedPaths.has(candidate)) {
      candidate = `${folder}/${baseSlug}-${n}.md`;
      n++;
    }
    usedPaths.add(candidate);
    const destAbs = join(kbDocsRoot, folder, `${slug}${n > 2 ? `-${n - 1}` : ""}.md`);
    mkdirSync(dirname(destAbs), { recursive: true });
    const fm: Record<string, string | number> = {
      title: entry.title || entry.id,
      author: entry.source || "user",
      created: entry.createdAt || Date.now(),
      updated: entry.updatedAt || entry.createdAt || Date.now(),
    };
    if (entry.type) fm.legacyType = entry.type;
    writeFileSync(destAbs, buildFrontmatter(fm, entry.content || ""), "utf-8");
    uuidToPath[entry.id] = candidate;
    migrated++;
  }

  try {
    const archived = join(kbRoot, "entries.legacy");
    if (!existsSync(archived)) renameSync(legacyEntries, archived);
  } catch (err) {
    logger.error("knowledge-migration", "archive legacy entries failed", { kbId, error: String(err) });
  }
  writeFileSync(markerPath, JSON.stringify({ migratedAt: Date.now(), count: migrated }, null, 2), "utf-8");
  logger.info("knowledge-migration", "KB entries migrated (0.7.0)", { kbId, count: migrated });
  return { kbId, migrated, uuidToPath };
}

/**
 * For rooms with `ruleIds: [uuid]`, convert each uuid to its migrated path.
 * Only runs for rooms whose kbId participated in entries migration.
 */
function migrateRoomRuleIds(allMappings: Record<string, Record<string, string>>): void {
  const rDir = roomsDir();
  if (!existsSync(rDir)) return;
  for (const entry of readdirSync(rDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roomJsonPath = join(rDir, entry.name, "room.json");
    if (!existsSync(roomJsonPath)) continue;
    let room: any;
    try { room = JSON.parse(readFileSync(roomJsonPath, "utf-8")); }
    catch { continue; }
    if (!room.knowledgeBaseId || !Array.isArray(room.ruleIds)) continue;
    const mapping = allMappings[room.knowledgeBaseId];
    if (!mapping) continue;
    const newRuleDocs: string[] = [];
    for (const uuid of room.ruleIds) {
      const path = mapping[uuid];
      if (path) newRuleDocs.push(path);
    }
    room.ruleDocs = newRuleDocs;
    delete room.ruleIds;
    writeFileSync(roomJsonPath, JSON.stringify(room, null, 2), "utf-8");
    logger.info("knowledge-migration", "room ruleIds→ruleDocs (0.7.0)", { roomId: room.id });
  }
}

// ── Migration 2: KB containers → single namespace (0.7.0 → 0.8.0) ──

/**
 * Compute a unique slug for a KB based on its display name. Falls back to
 * `kbId` when the name is empty. Used when moving `<kbId>/docs/` into
 * `docs/<slug>/`.
 */
function resolveKbSlug(
  kb: LegacyKBMeta,
  takenSlugs: Set<string>,
): string {
  const base = (kb.name && slugify(kb.name)) || kb.id.slice(0, 8);
  if (!takenSlugs.has(base)) {
    takenSlugs.add(base);
    return base;
  }
  let n = 2;
  while (takenSlugs.has(`${base}-${n}`)) n++;
  const uniq = `${base}-${n}`;
  takenSlugs.add(uniq);
  return uniq;
}

/**
 * Scan the knowledge dir for legacy KB directories (containing a
 * `knowledge.json` sibling of `docs/`). Returns their metadata.
 */
function listLegacyKBs(): LegacyKBMeta[] {
  const kDir = knowledgeDir();
  if (!existsSync(kDir)) return [];
  const out: LegacyKBMeta[] = [];
  for (const entry of readdirSync(kDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "docs") continue;
    if (entry.name.endsWith(".legacy")) continue;
    const jsonPath = join(kDir, entry.name, "knowledge.json");
    if (!existsSync(jsonPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8")) as LegacyKBMeta;
      if (meta?.id) out.push(meta);
    } catch (err) {
      logger.error("knowledge-migration", "parse kb json failed (0.8.0)", { id: entry.name, error: String(err) });
    }
  }
  return out;
}

interface SingleNamespaceMigrationReport {
  migrated: number;
  kbSlugMap: Record<string, string>;
}

/**
 * Move each legacy KB's `docs/` contents into `docs/<kbSlug>/` at the shared
 * namespace root. Rename the original `<kbId>/` directory to `<kbId>.legacy/`
 * so existing backups (entries.legacy/, knowledge.json) are preserved.
 *
 * Returns a map of kbId → slug, used to rewrite room references.
 */
function migrateToSingleNamespace(): SingleNamespaceMigrationReport {
  const newDocsRoot = docsRootDir();
  const kbs = listLegacyKBs();
  if (kbs.length === 0) {
    // Nothing to migrate. Ensure the root exists for fresh installs.
    mkdirSync(newDocsRoot, { recursive: true });
    return { migrated: 0, kbSlugMap: {} };
  }

  mkdirSync(newDocsRoot, { recursive: true });

  const takenSlugs = new Set<string>();
  // Pre-reserve any existing top-level folders so we don't collide with them.
  try {
    for (const e of readdirSync(newDocsRoot, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) takenSlugs.add(e.name);
    }
  } catch { /* ignore */ }

  const kbSlugMap: Record<string, string> = {};
  let migrated = 0;

  for (const kb of kbs) {
    const slug = resolveKbSlug(kb, takenSlugs);
    kbSlugMap[kb.id] = slug;

    const srcDocs = join(knowledgeDir(), kb.id, "docs");
    const destDir = join(newDocsRoot, slug);

    if (existsSync(srcDocs)) {
      if (existsSync(destDir)) {
        // Unexpected: destination already exists. Merge file-by-file without overwrite.
        mergeDirNoOverwrite(srcDocs, destDir);
      } else {
        cpSync(srcDocs, destDir, { recursive: true });
      }
    } else {
      // No docs in this KB — still create an empty folder to preserve intent.
      mkdirSync(destDir, { recursive: true });
    }

    // Rename the entire legacy KB directory for preservation.
    const legacyDir = join(knowledgeDir(), `${kb.id}.legacy`);
    try {
      if (!existsSync(legacyDir)) {
        renameSync(join(knowledgeDir(), kb.id), legacyDir);
      }
    } catch (err) {
      logger.error("knowledge-migration", "archive kb dir failed (0.8.0)", { kbId: kb.id, error: String(err) });
    }

    logger.info("knowledge-migration", "KB moved to single namespace (0.8.0)", {
      kbId: kb.id, name: kb.name, slug,
    });
    migrated++;
  }

  return { migrated, kbSlugMap };
}

function mergeDirNoOverwrite(srcDir: string, destDir: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name);
    const d = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      mergeDirNoOverwrite(s, d);
    } else if (entry.isFile()) {
      if (!existsSync(d)) cpSync(s, d);
    }
  }
}

/**
 * Strip `knowledgeBaseId` from every room and (if a slug map is provided)
 * prefix each room's `ruleDocs` path with its former KB's slug. Also backs up
 * `rooms/<id>/room.json` to `room.json.pre-0.8.0-backup` before rewrite.
 */
function migrateRoomFields(kbSlugMap: Record<string, string>): void {
  const rDir = roomsDir();
  if (!existsSync(rDir)) return;
  for (const entry of readdirSync(rDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roomJsonPath = join(rDir, entry.name, "room.json");
    if (!existsSync(roomJsonPath)) continue;

    let room: any;
    try { room = JSON.parse(readFileSync(roomJsonPath, "utf-8")); }
    catch { continue; }

    const hasLegacyKbId = typeof room.knowledgeBaseId === "string" && room.knowledgeBaseId.length > 0;
    const hasLegacyRuleIds = Array.isArray(room.ruleIds) && room.ruleIds.length > 0;
    if (!hasLegacyKbId && !hasLegacyRuleIds) continue; // already migrated

    // Back up before rewriting
    try {
      const backup = roomJsonPath + ".pre-0.8.0-backup";
      if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(room, null, 2), "utf-8");
    } catch (err) {
      logger.error("knowledge-migration", "backup room.json failed (0.8.0)", { roomId: room.id, error: String(err) });
    }

    // Rewrite ruleDocs with slug prefix
    if (hasLegacyKbId && Array.isArray(room.ruleDocs)) {
      const slug = kbSlugMap[room.knowledgeBaseId];
      if (slug) {
        room.ruleDocs = room.ruleDocs.map((p: string) => {
          const normalized = p.replace(/^\/+/, "");
          // Don't double-prefix if for some reason already prefixed
          if (normalized.startsWith(`${slug}/`)) return normalized;
          return `${slug}/${normalized}`;
        });
      }
    }

    delete room.knowledgeBaseId;
    delete room.ruleIds; // 0.7.0 deprecated; drop now

    writeFileSync(roomJsonPath, JSON.stringify(room, null, 2), "utf-8");
    logger.info("knowledge-migration", "room migrated to single namespace (0.8.0)", {
      roomId: room.id,
      ruleDocs: room.ruleDocs,
    });
  }
}

// ── Entry point ──

/** Run all knowledge migrations in order. Idempotent. Call at server startup. */
export function runKnowledgeMigration(): void {
  const kDir = knowledgeDir();
  if (!existsSync(kDir)) mkdirSync(kDir, { recursive: true });

  // Phase 1: entries/*.json → docs/*.md (per-KB, 0.7.0)
  const entryMappings: Record<string, Record<string, string>> = {};
  try {
    for (const entry of readdirSync(kDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "docs") continue;
      if (entry.name.endsWith(".legacy")) continue;
      try {
        const result = migrateKbEntries(entry.name);
        if (result) entryMappings[result.kbId] = result.uuidToPath;
      } catch (err) {
        logger.error("knowledge-migration", "KB entries migration failed", { kbId: entry.name, error: String(err) });
      }
    }
    if (Object.keys(entryMappings).length > 0) {
      migrateRoomRuleIds(entryMappings);
    }
  } catch (err) {
    logger.error("knowledge-migration", "phase 1 failed", { error: String(err) });
  }

  // Phase 2: KB containers → single namespace (0.8.0)
  let kbSlugMap: Record<string, string> = {};
  try {
    const report = migrateToSingleNamespace();
    kbSlugMap = report.kbSlugMap;
    if (report.migrated > 0) {
      logger.info("knowledge-migration", "single-namespace migration complete", {
        count: report.migrated, slugMap: kbSlugMap,
      });
    }
  } catch (err) {
    logger.error("knowledge-migration", "phase 2 failed", { error: String(err) });
  }

  // Always rewrite room fields: even if no KBs were migrated this run, prior
  // runs may have left orphaned knowledgeBaseId / ruleIds that should be cleaned.
  try {
    migrateRoomFields(kbSlugMap);
  } catch (err) {
    logger.error("knowledge-migration", "room field migration failed", { error: String(err) });
  }

  // Built-in asset seeding is handled by seedBuiltinAssets() in server startup.
}

// Silence the unused-import warnings for functions that might later be needed
// externally. (statSync stays available for future checks.)
void statSync;
