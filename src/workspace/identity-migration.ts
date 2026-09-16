/**
 * Identity / three-memory redesign — one-shot migration (spec §3.1 + rc.5 auto-start).
 *
 * Completion is judged by file presence (F1), not the done marker.
 * Snapshot covers only migration-touched subtrees (no agent-events / sessions).
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
import { join, dirname, relative } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../kernel/logger.js";

export interface IdentityMigrationAction {
  step: string;
  op: string;
  from?: string;
  to?: string;
  note?: string;
}

export interface IdentityMigrationResult {
  version: "identity-memory-v1";
  ts: string;
  apply: boolean;
  skipped: boolean;
  reason?: string;
  bossmodeDir: string;
  backupDir: string | null;
  actions: IdentityMigrationAction[];
  error?: string;
}

export interface RunIdentityMigrationOpts {
  /** When true, write disk. Default false = dry-run. */
  apply?: boolean;
  /** Override bossmode root (tests). */
  bossmodeDir?: string;
  /** Quiet console; still logs via logger when apply. */
  quiet?: boolean;
}

function listDirs(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listFiles(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

function isNonEmptyDir(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function safeSlug(name: string): string {
  const s = String(name || "room")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "room";
}

/**
 * Data-driven: any leftover legacy asset means migration still needed.
 * Marker is log-only (F1).
 */
export function needsIdentityMigration(bossmodeDir: string = getBossmodeDir()): boolean {
  const membersRoot = join(bossmodeDir, "members");
  for (const id of listDirs(membersRoot)) {
    const scopes = join(membersRoot, id, "memory", "scopes");
    if (existsSync(scopes)) {
      for (const scope of listDirs(scopes)) {
        for (const layer of ["principles", "mainline"] as const) {
          const p = join(scopes, scope, `${layer}.md`);
          if (existsSync(p) && readText(p).trim()) return true;
        }
      }
    }
    for (const layer of ["principles", "mainline"] as const) {
      const p = join(membersRoot, id, "memory", `${layer}.md`);
      if (existsSync(p) && readText(p).trim()) return true;
    }
  }

  const docsRoot = join(bossmodeDir, "knowledge", "docs");
  if (existsSync(docsRoot)) {
    for (const name of readdirSync(docsRoot)) {
      const p = join(docsRoot, name);
      try {
        const st = statSync(p);
        if (st.isFile()) return true;
        if (st.isDirectory() && isNonEmptyDir(p)) return true;
      } catch {
        /* skip */
      }
    }
  }

  const roomsRoot = join(bossmodeDir, "rooms");
  for (const roomId of listDirs(roomsRoot)) {
    if (roomId.startsWith("dm:")) continue;
    const rp = join(roomsRoot, roomId, "memory", "room-principles.md");
    if (existsSync(rp) && readText(rp).trim()) return true;
    const memDir = join(roomsRoot, roomId, "memory");
    if (!existsSync(memDir)) continue;
    for (const name of listFiles(memDir)) {
      if (name.endsWith(".md") && name !== "room-principles.md") {
        if (readText(join(memDir, name)).trim()) return true;
      }
    }
    const roomMembersMem = join(memDir, "members");
    if (existsSync(roomMembersMem)) {
      for (const mid of listDirs(roomMembersMem)) {
        for (const layer of ["principles", "mainline"] as const) {
          const p = join(roomMembersMem, mid, `${layer}.md`);
          if (existsSync(p) && readText(p).trim()) return true;
        }
      }
    }
  }

  return false;
}

/**
 * Run migration. Default dry-run. Pass `{ apply: true }` to write.
 * Never throws for operational failures when called from daemon — returns error field.
 */
export function runIdentityMigration(opts: RunIdentityMigrationOpts = {}): IdentityMigrationResult {
  const apply = opts.apply === true;
  const boss = opts.bossmodeDir || getBossmodeDir();
  const quiet = opts.quiet === true;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const backupDir = join(boss, `migration-backup-identity-v1-${ts}`);
  const donePath = join(boss, "migrations", "identity-memory-v1.done.json");
  const actions: IdentityMigrationAction[] = [];

  const emit = (msg: string) => {
    if (!quiet) console.log(msg);
  };

  const record = (action: IdentityMigrationAction) => {
    actions.push(action);
    const verb = apply ? "APPLY" : "DRY";
    emit(
      `[${verb}] ${action.step}: ${action.op} ${action.from || ""} → ${action.to || ""} ${action.note || ""}`.trim(),
    );
  };

  const copyOrMoveFile = (from: string, to: string, step: string, move = false) => {
    if (!existsSync(from)) return;
    if (existsSync(to)) {
      record({ step, op: "skip-exists", from, to, note: "destination already has content" });
      return;
    }
    record({ step, op: move ? "move" : "copy", from, to });
    if (!apply) return;
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
  };

  const mergeDirNoOverwrite = (from: string, to: string, step: string) => {
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
  };

  try {
    if (!existsSync(boss)) {
      return {
        version: "identity-memory-v1",
        ts: new Date().toISOString(),
        apply,
        skipped: true,
        reason: "bossmode_dir_missing",
        bossmodeDir: boss,
        backupDir: null,
        actions,
      };
    }

    if (apply && !needsIdentityMigration(boss)) {
      emit(`identity-memory-v1: nothing to migrate (data-driven clean) · ${boss}`);
      return {
        version: "identity-memory-v1",
        ts: new Date().toISOString(),
        apply,
        skipped: true,
        reason: "already_clean",
        bossmodeDir: boss,
        backupDir: null,
        actions,
      };
    }

    emit(`identity-memory-v1 migration · mode=${apply ? "APPLY" : "DRY-RUN"} · BOSSMODE_DIR=${boss}`);

    // ── 1. Narrow snapshot (no agent-events / sessions) ──
    {
      const step = "1-snapshot";
      const copies: Array<{ from: string; to: string }> = [];
      const membersRoot = join(boss, "members");
      for (const id of listDirs(membersRoot)) {
        const mem = join(membersRoot, id, "memory");
        if (existsSync(mem)) {
          copies.push({ from: mem, to: join(backupDir, "members", id, "memory") });
        }
      }
      const roomsRoot = join(boss, "rooms");
      for (const roomId of listDirs(roomsRoot)) {
        const mem = join(roomsRoot, roomId, "memory");
        if (existsSync(mem)) {
          copies.push({ from: mem, to: join(backupDir, "rooms", roomId, "memory") });
        }
      }
      const docs = join(boss, "knowledge", "docs");
      if (existsSync(docs)) copies.push({ from: docs, to: join(backupDir, "knowledge", "docs") });
      const projects = join(boss, "memory", "projects");
      if (existsSync(projects)) copies.push({ from: projects, to: join(backupDir, "memory", "projects") });

      if (copies.length === 0) {
        record({ step, op: "skip", note: "nothing to snapshot" });
      } else {
        record({ step, op: "snapshot-root", to: backupDir, note: `${copies.length} subtrees (memory-only)` });
        if (apply) {
          ensureDir(backupDir);
          for (const c of copies) {
            ensureDir(dirname(c.to));
            cpSync(c.from, c.to, { recursive: true });
            record({ step, op: "snapshot-copy", from: c.from, to: c.to });
          }
        }
      }
    }

    // Persona conversion is handled exclusively by the offline member-storage migration.

    // ── 3. archive member principles/mainline ──
    {
      const step = "3-archive-member";
      const membersRoot = join(boss, "members");
      for (const id of listDirs(membersRoot)) {
        const memRoot = join(membersRoot, id, "memory");
        if (!existsSync(memRoot)) continue;
        const archiveRoot = join(membersRoot, id, "archive");
        for (const layer of ["principles", "mainline"] as const) {
          const src = join(memRoot, `${layer}.md`);
          if (!existsSync(src)) continue;
          copyOrMoveFile(src, join(archiveRoot, `${layer}-global.md`), step, true);
        }
        const scopesRoot = join(memRoot, "scopes");
        if (!existsSync(scopesRoot)) continue;
        for (const scopeName of listDirs(scopesRoot)) {
          for (const layer of ["principles", "mainline"] as const) {
            const src = join(scopesRoot, scopeName, `${layer}.md`);
            if (!existsSync(src)) continue;
            copyOrMoveFile(src, join(archiveRoot, `${layer}-${scopeName}.md`), step, true);
          }
        }
      }
    }

    // ── 3b. knowledge/docs → memory/projects ──
    {
      const step = "3b-library-move";
      const docsRoot = join(boss, "knowledge", "docs");
      const projectsRoot = join(boss, "memory", "projects");
      if (!existsSync(docsRoot)) {
        record({ step, op: "skip", from: docsRoot, note: "no knowledge/docs" });
      } else {
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
            if (st.isDirectory()) {
              record({ step, op: "merge-into-existing", from, to });
              if (apply) mergeDirNoOverwrite(from, to, step);
            } else {
              record({ step, op: "skip-exists", from, to });
            }
            continue;
          }
          record({ step, op: "move", from, to });
          if (apply) {
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
    }

    // ── 4. room principles + room memory md ──
    {
      const step = "4-room-archive";
      const roomsRoot = join(boss, "rooms");
      const archiveBase = join(boss, "memory", "projects", "archive");
      for (const roomId of listDirs(roomsRoot)) {
        if (roomId.startsWith("dm:")) continue;
        const roomDir = join(roomsRoot, roomId);
        let roomName = roomId;
        const roomJson = join(roomDir, "room.json");
        if (existsSync(roomJson)) {
          try {
            const r = JSON.parse(readText(roomJson)) as { name?: string };
            if (r.name) roomName = r.name;
          } catch {
            /* ignore */
          }
        }
        const slug = safeSlug(roomName);
        let destDir = join(archiveBase, slug);
        if (existsSync(destDir) && apply) {
          destDir = join(archiveBase, `${slug}-${roomId.slice(0, 8)}`);
        }

        const memDir = join(roomDir, "memory");
        if (!existsSync(memDir)) continue;

        const rp = join(memDir, "room-principles.md");
        if (existsSync(rp)) copyOrMoveFile(rp, join(destDir, "room-principles.md"), step, true);

        for (const name of listFiles(memDir)) {
          if (!name.endsWith(".md") || name === "room-principles.md") continue;
          copyOrMoveFile(join(memDir, name), join(destDir, name), step, true);
        }

        const roomMembersMem = join(memDir, "members");
        if (existsSync(roomMembersMem)) {
          for (const mid of listDirs(roomMembersMem)) {
            for (const layer of ["principles", "mainline"] as const) {
              const src = join(roomMembersMem, mid, `${layer}.md`);
              if (!existsSync(src)) continue;
              copyOrMoveFile(src, join(destDir, `member-${mid}-${layer}.md`), step, true);
            }
          }
        }
      }
    }

    // ── 5. marker ──
    const payload: IdentityMigrationResult = {
      version: "identity-memory-v1",
      ts: new Date().toISOString(),
      apply,
      skipped: false,
      bossmodeDir: boss,
      backupDir: apply ? backupDir : null,
      actions,
    };
    record({
      step: "5-marker",
      op: apply ? "write-marker" : "would-write-marker",
      to: donePath,
    });
    if (apply) {
      ensureDir(dirname(donePath));
      writeFileSync(donePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    }

    emit(`--- summary: ${actions.length} actions · mode=${apply ? "APPLY" : "DRY-RUN"} ---`);
    if (!apply) {
      emit("Re-run with --apply to write. Review the plan above first.");
    } else {
      emit(`Backup: ${backupDir}`);
      emit(`Marker: ${donePath}`);
      logger.info("identity-migration", "identity-memory-v1 applied", {
        actions: actions.length,
        backupDir,
      });
    }

    return payload;
  } catch (err) {
    const error = String((err as Error)?.message || err);
    logger.error("identity-migration", "identity-memory-v1 failed", { error });
    return {
      version: "identity-memory-v1",
      ts: new Date().toISOString(),
      apply,
      skipped: false,
      bossmodeDir: boss,
      backupDir: apply ? backupDir : null,
      actions,
      error,
    };
  }
}

/** Daemon hook: data-driven detect → snapshot+apply. Never throws. */
export function runIdentityMigrationOnStartup(): IdentityMigrationResult | null {
  const boss = getBossmodeDir();
  try {
    if (!needsIdentityMigration(boss)) {
      logger.info("identity-migration", "startup skip — already clean");
      return null;
    }
    logger.info("identity-migration", "startup apply — legacy assets detected");
    const result = runIdentityMigration({ apply: true, quiet: true });
    if (result.error) {
      logger.error("identity-migration", "startup apply failed (server continues)", {
        error: result.error,
        actions: result.actions.length,
      });
    } else if (result.skipped) {
      logger.info("identity-migration", "startup skipped", { reason: result.reason });
    } else {
      logger.info("identity-migration", "startup apply ok", {
        actions: result.actions.length,
        backupDir: result.backupDir,
      });
    }
    return result;
  } catch (err) {
    logger.error("identity-migration", "startup threw (server continues)", {
      error: String((err as Error)?.message || err),
    });
    return null;
  }
}
