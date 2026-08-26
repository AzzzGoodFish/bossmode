#!/usr/bin/env node
/**
 * Identity / three-memory redesign — one-shot migration (spec §3.1).
 *
 * Default = dry-run (print plan only). Pass --apply to write.
 * Completion is judged by file presence, not the done marker (F1 lesson).
 *
 * Steps (fixed order):
 *  1. Snapshot related subtrees → migration-backup-identity-v1-<ts>/
 *  2. persona.md → member.md ## Persona (skip if Persona already non-empty)
 *  3. Archive member principles/mainline (global + scopes/**)
 *  3b. knowledge/docs/* → memory/projects/* (skip empty dirs; no overwrite)
 *  4. rooms/<id>/memory/room-principles.md + other .md → memory/projects/archive/<slug>/
 *  5. Write migrations/identity-memory-v1.done.json with the actual move list
 *
 * Usage:
 *   node scripts/migrate-identity-memory-v1.mjs
 *   node scripts/migrate-identity-memory-v1.mjs --apply
 *   BOSSMODE_DIR=/path node scripts/migrate-identity-memory-v1.mjs --apply
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  statSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const BOSSMODE_DIR = process.env.BOSSMODE_DIR || join(homedir(), ".bossmode");
const TS = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
const BACKUP_DIR = join(BOSSMODE_DIR, `migration-backup-identity-v1-${TS}`);
const DONE_PATH = join(BOSSMODE_DIR, "migrations", "identity-memory-v1.done.json");

/** @type {Array<Record<string, unknown>>} */
const actions = [];
/** @type {string[]} */
const logs = [];

function log(msg) {
  logs.push(msg);
  console.log(msg);
}

function record(action) {
  actions.push(action);
  const verb = APPLY ? "APPLY" : "DRY";
  log(`[${verb}] ${action.step}: ${action.op} ${action.from || ""} → ${action.to || ""} ${action.note || ""}`.trim());
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function isNonEmptyDir(p) {
  if (!existsSync(p)) return false;
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function listDirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listFiles(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

function safeSlug(name) {
  const s = String(name || "room")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "room";
}

function readText(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function normalizePersonaBlob(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/^##\s+Persona\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when member.md already contains this persona body (content match, not heading-only). */
function memberAlreadyHasPersonaContent(memberMdText, personaContent) {
  const needle = normalizePersonaBlob(personaContent);
  if (!needle) return false;
  return normalizePersonaBlob(memberMdText).includes(needle);
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { fm: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { fm: "", body: raw };
  const close = end + 4; // \n---
  const after = raw.slice(close).replace(/^\n/, "");
  return { fm: raw.slice(0, close), body: after };
}

function copyOrMoveFile(from, to, step, { move = false } = {}) {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    record({ step, op: "skip-exists", from, to, note: "destination already has content" });
    return;
  }
  record({ step, op: move ? "move" : "copy", from, to });
  if (!APPLY) return;
  ensureDir(dirname(to));
  if (move) {
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
      rmSync(from, { force: true });
    }
  } else {
    copyFileSync(from, to);
  }
}

function copyTree(from, to, step) {
  if (!existsSync(from)) return;
  if (!isNonEmptyDir(from) && !statSync(from).isFile()) {
    record({ step, op: "skip-empty", from, to });
    return;
  }
  record({ step, op: "copy-tree", from, to });
  if (!APPLY) return;
  ensureDir(dirname(to));
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
}

// ── Step 1: snapshot ──────────────────────────────────────────────
function step1Snapshot() {
  const step = "1-snapshot";
  const targets = [
    join(BOSSMODE_DIR, "members"),
    join(BOSSMODE_DIR, "rooms"),
    join(BOSSMODE_DIR, "knowledge", "docs"),
    join(BOSSMODE_DIR, "memory", "projects"),
  ].filter((p) => existsSync(p));

  if (targets.length === 0) {
    record({ step, op: "skip", note: "nothing to snapshot" });
    return;
  }
  record({ step, op: "snapshot-root", to: BACKUP_DIR });
  if (!APPLY) return;
  ensureDir(BACKUP_DIR);
  for (const t of targets) {
    const dest = join(BACKUP_DIR, relative(BOSSMODE_DIR, t));
    ensureDir(dirname(dest));
    cpSync(t, dest, { recursive: true });
    record({ step, op: "snapshot-copy", from: t, to: dest });
  }
}

// ── Step 2: persona → member.md ───────────────────────────────────
function step2PersonaMerge() {
  const step = "2-persona-merge";
  const membersRoot = join(BOSSMODE_DIR, "members");
  for (const id of listDirs(membersRoot)) {
    if (!id.startsWith("mem_") && !id.startsWith("rm_")) continue;
    const personaPath = join(membersRoot, id, "memory", "persona.md");
    const memberMd = join(membersRoot, id, "member.md");
    if (!existsSync(personaPath)) {
      record({ step, op: "skip", from: personaPath, note: "no persona.md" });
      continue;
    }
    const personaRaw = readText(personaPath).trim();
    if (!personaRaw) {
      record({ step, op: "skip", from: personaPath, note: "empty persona" });
      continue;
    }
    // Strip persona frontmatter if any — body only into ## Persona
    const { body: personaBody } = parseFrontmatter(personaRaw);
    const personaContent = personaBody.trim() || personaRaw;

    let existing = existsSync(memberMd) ? readText(memberMd) : "";
    const alreadyFolded = existing && memberAlreadyHasPersonaContent(existing, personaContent);

    if (!alreadyFolded) {
      // Build member.md
      let fmBlock = "---\nname: " + id + "\n---\n";
      let bodyRest = "";
      if (existing) {
        const parsed = parseFrontmatter(existing);
        if (parsed.fm) fmBlock = parsed.fm.endsWith("\n") ? parsed.fm : parsed.fm + "\n";
        // Drop an empty/partial ## Persona heading block if present; keep other sections.
        bodyRest = parsed.body
          .replace(/^##\s+Persona\s*\n[\s\S]*?(?=^##\s|$)/m, "")
          .trim();
      } else {
        const mj = join(membersRoot, id, "member.json");
        if (existsSync(mj)) {
          try {
            const rec = JSON.parse(readText(mj));
            if (rec.name) fmBlock = `---\nname: ${rec.name}\n---\n`;
          } catch { /* ignore */ }
        }
      }

      const parts = [fmBlock.trimEnd(), "", "## Persona", "", personaContent];
      if (bodyRest) parts.push("", bodyRest);
      const next = parts.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";

      record({ step, op: "write", from: personaPath, to: memberMd, note: `chars=${next.length}` });
      if (APPLY) {
        ensureDir(dirname(memberMd));
        writeFileSync(memberMd, next, "utf-8");
      }
    } else {
      record({ step, op: "skip", from: personaPath, to: memberMd, note: "member.md already contains persona body" });
    }

    // Always archive persona.md after fold/skip so a second --apply cannot re-read it (F1: file presence).
    const archivePersona = join(membersRoot, id, "archive", "persona.md");
    copyOrMoveFile(personaPath, archivePersona, step, { move: true });
  }
}

// ── Step 3: archive member principles/mainline ────────────────────
function step3ArchiveMemberMemory() {
  const step = "3-archive-member";
  const membersRoot = join(BOSSMODE_DIR, "members");
  for (const id of listDirs(membersRoot)) {
    const memRoot = join(membersRoot, id, "memory");
    if (!existsSync(memRoot)) continue;
    const archiveRoot = join(membersRoot, id, "archive");

    // Global principles/mainline (if ever stored at memory/*.md besides persona)
    for (const layer of ["principles", "mainline"]) {
      const src = join(memRoot, `${layer}.md`);
      if (!existsSync(src)) continue;
      const dest = join(archiveRoot, `${layer}-global.md`);
      copyOrMoveFile(src, dest, step, { move: true });
    }

    // scopes/**
    const scopesRoot = join(memRoot, "scopes");
    if (!existsSync(scopesRoot)) continue;
    for (const scopeName of listDirs(scopesRoot)) {
      for (const layer of ["principles", "mainline"]) {
        const src = join(scopesRoot, scopeName, `${layer}.md`);
        if (!existsSync(src)) continue;
        const dest = join(archiveRoot, `${layer}-${scopeName}.md`);
        copyOrMoveFile(src, dest, step, { move: true });
      }
    }
  }
}

// ── Step 3b: Library docs → memory/projects ───────────────────────
function step3bLibraryMove() {
  const step = "3b-library-move";
  const docsRoot = join(BOSSMODE_DIR, "knowledge", "docs");
  const projectsRoot = join(BOSSMODE_DIR, "memory", "projects");
  if (!existsSync(docsRoot)) {
    record({ step, op: "skip", from: docsRoot, note: "no knowledge/docs" });
    return;
  }
  for (const name of readdirSync(docsRoot)) {
    const from = join(docsRoot, name);
    const to = join(projectsRoot, name);
    let st;
    try {
      st = statSync(from);
    } catch {
      continue;
    }
    if (st.isDirectory() && !isNonEmptyDir(from)) {
      record({ step, op: "skip-empty", from, to });
      continue;
    }
    if (existsSync(to)) {
      // Merge: copy missing children only
      if (st.isDirectory()) {
        record({ step, op: "merge-into-existing", from, to });
        if (APPLY) mergeDirNoOverwrite(from, to, step);
      } else {
        record({ step, op: "skip-exists", from, to });
      }
      continue;
    }
    record({ step, op: "move", from, to });
    if (APPLY) {
      ensureDir(projectsRoot);
      try {
        renameSync(from, to);
      } catch {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
    }
  }
}

function mergeDirNoOverwrite(from, to, step) {
  ensureDir(to);
  for (const name of readdirSync(from)) {
    const f = join(from, name);
    const t = join(to, name);
    const st = statSync(f);
    if (st.isDirectory()) {
      mergeDirNoOverwrite(f, t, step);
    } else if (!existsSync(t)) {
      ensureDir(dirname(t));
      copyFileSync(f, t);
      record({ step, op: "merge-copy", from: f, to: t });
    } else {
      record({ step, op: "skip-exists", from: f, to: t });
    }
  }
}

// ── Step 4: room principles + room library md ─────────────────────
function step4RoomArchive() {
  const step = "4-room-archive";
  const roomsRoot = join(BOSSMODE_DIR, "rooms");
  const archiveBase = join(BOSSMODE_DIR, "memory", "projects", "archive");
  for (const roomId of listDirs(roomsRoot)) {
    if (roomId.startsWith("dm:")) continue;
    const roomDir = join(roomsRoot, roomId);
    const roomJson = join(roomDir, "room.json");
    let roomName = roomId;
    if (existsSync(roomJson)) {
      try {
        const r = JSON.parse(readText(roomJson));
        if (r.name) roomName = r.name;
      } catch { /* ignore */ }
    }
    const slug = safeSlug(roomName);
    // disambiguate if collision
    let destDir = join(archiveBase, slug);
    if (existsSync(destDir) && APPLY) {
      destDir = join(archiveBase, `${slug}-${roomId.slice(0, 8)}`);
    } else if (!APPLY) {
      destDir = join(archiveBase, slug);
    }

    const memDir = join(roomDir, "memory");
    if (!existsSync(memDir)) continue;

    // room-principles.md
    const rp = join(memDir, "room-principles.md");
    if (existsSync(rp)) {
      copyOrMoveFile(rp, join(destDir, "room-principles.md"), step, { move: true });
    }

    // other .md under rooms/<id>/memory/ (not members/ subdir tree — those are legacy per-room member files)
    for (const name of listFiles(memDir)) {
      if (!name.endsWith(".md")) continue;
      if (name === "room-principles.md") continue;
      copyOrMoveFile(join(memDir, name), join(destDir, name), step, { move: true });
    }

    // Legacy per-room member principles/mainline under memory/members/<id>/
    const roomMembersMem = join(memDir, "members");
    if (existsSync(roomMembersMem)) {
      for (const mid of listDirs(roomMembersMem)) {
        for (const layer of ["principles", "mainline"]) {
          const src = join(roomMembersMem, mid, `${layer}.md`);
          if (!existsSync(src)) continue;
          const dest = join(destDir, `member-${mid}-${layer}.md`);
          copyOrMoveFile(src, dest, step, { move: true });
        }
      }
    }
  }
}

// ── Step 5: done marker ───────────────────────────────────────────
function step5Marker() {
  const step = "5-marker";
  const payload = {
    version: "identity-memory-v1",
    ts: new Date().toISOString(),
    apply: APPLY,
    bossmodeDir: BOSSMODE_DIR,
    backupDir: APPLY ? BACKUP_DIR : null,
    actions,
    note: "Completion is judged by file presence, not this marker (F1).",
  };
  record({ step, op: APPLY ? "write-marker" : "would-write-marker", to: DONE_PATH });
  if (APPLY) {
    ensureDir(dirname(DONE_PATH));
    writeFileSync(DONE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
  return payload;
}

function main() {
  log(`identity-memory-v1 migration · mode=${APPLY ? "APPLY" : "DRY-RUN"} · BOSSMODE_DIR=${BOSSMODE_DIR}`);
  if (!existsSync(BOSSMODE_DIR)) {
    console.error(`BOSSMODE_DIR does not exist: ${BOSSMODE_DIR}`);
    process.exit(1);
  }
  step1Snapshot();
  step2PersonaMerge();
  step3ArchiveMemberMemory();
  step3bLibraryMove();
  step4RoomArchive();
  const payload = step5Marker();
  log(`--- summary: ${actions.length} actions · mode=${APPLY ? "APPLY" : "DRY-RUN"} ---`);
  if (!APPLY) {
    log("Re-run with --apply to write. Review the plan above first.");
  } else {
    log(`Backup: ${BACKUP_DIR}`);
    log(`Marker: ${DONE_PATH}`);
  }
  // Machine-readable tail for tests
  if (process.env.MIGRATE_JSON_OUT) {
    writeFileSync(process.env.MIGRATE_JSON_OUT, JSON.stringify(payload, null, 2));
  }
}

main();
