/**
 * 0.20 archive listing + import helpers (WS-A A5/A6 skeleton).
 * Full 0.19→0.20 migration writer lands with the migration runner;
 * this module reads backups/legacy-* and fired-* for the import wizard.
 * Contract §7.
 */
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { createMember, type MemberRecord } from "./member-registry.js";
import { writeMemoryLayer, ensureMemorySkeleton } from "./member-memory-store.js";

export interface ArchiveListItem {
  name: string;
  template: string;
  hasPersona: boolean;
  roomScopes: Array<{ room: string; hasPrinciples: boolean; hasMainline: boolean }>;
  archivePath: string;
  credentialHint?: string | null;
  conflicts?: string[];
  kind: "legacy" | "fired";
}

function backupsRoot(): string {
  return join(getBossmodeDir(), "backups");
}

function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * List importable archives under backups/.
 * - legacy-0.19-* : uses manifest.json members[]
 * - fired-* : single-member archive (member.json + memory/)
 */
export function listArchives(): ArchiveListItem[] {
  const root = backupsRoot();
  if (!existsSync(root)) return [];
  const items: ArchiveListItem[] = [];

  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const archivePath = join("backups", ent.name);
    const full = join(root, ent.name);

    if (ent.name.startsWith("legacy-0.19-") || ent.name.startsWith("legacy-")) {
      const manifest = readJsonIfExists<{
        members?: Array<{
          name: string;
          sourceAgent?: string;
          credentialId?: string;
          conflicts?: string[];
          rooms?: Array<{ room: string; hasPrinciples?: boolean; hasMainline?: boolean }>;
        }>;
      }>(join(full, "manifest.json"));
      if (!manifest?.members?.length) continue;
      // Aggregate by name (contract: same name = one employee)
      const byName = new Map<string, ArchiveListItem>();
      for (const m of manifest.members) {
        const existing = byName.get(m.name);
        const roomScopes = (m.rooms || []).map((r) => ({
          room: r.room,
          hasPrinciples: !!r.hasPrinciples,
          hasMainline: !!r.hasMainline,
        }));
        if (!existing) {
          byName.set(m.name, {
            name: m.name,
            template: m.sourceAgent || "general",
            hasPersona: true,
            roomScopes,
            archivePath,
            credentialHint: m.credentialId ?? null,
            conflicts: m.conflicts,
            kind: "legacy",
          });
        } else {
          existing.roomScopes.push(...roomScopes);
          if (m.conflicts?.length) {
            existing.conflicts = [...(existing.conflicts || []), ...m.conflicts];
          }
        }
      }
      items.push(...byName.values());
      continue;
    }

    if (ent.name.startsWith("fired-")) {
      const memberJson = readJsonIfExists<{ name?: string; agentTemplate?: string; global?: { credentialId?: string } }>(
        join(full, "member.json"),
      );
      if (!memberJson?.name) continue;
      const personaPath = join(full, "memory", "persona.md");
      items.push({
        name: memberJson.name,
        template: memberJson.agentTemplate || "general",
        hasPersona: existsSync(personaPath) && statSync(personaPath).size > 0,
        roomScopes: [],
        archivePath,
        credentialHint: memberJson.global?.credentialId ?? null,
        kind: "fired",
      });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Import persona (+ optional credential link) from an archive entry.
 * Does NOT import old room scope principles/mainline (member self-service from archive).
 */
export function importMemberFromArchive(opts: {
  archivePath: string;
  name: string;
  agentTemplate?: string;
  credentialId?: string | null;
}): MemberRecord {
  const full = join(getBossmodeDir(), opts.archivePath);
  if (!existsSync(full)) throw new Error("archive_not_found");

  // Prefer fired layout (member.json at root); else leave persona empty for legacy (filled below if found)
  let persona = "";
  let template = opts.agentTemplate || "general";
  let cred = opts.credentialId ?? null;

  const firedPersona = join(full, "memory", "persona.md");
  if (existsSync(firedPersona)) {
    persona = readFileSync(firedPersona, "utf-8");
    const mj = readJsonIfExists<{ agentTemplate?: string; global?: { credentialId?: string | null } }>(
      join(full, "member.json"),
    );
    if (mj?.agentTemplate) template = opts.agentTemplate || mj.agentTemplate;
    if (cred == null && mj?.global?.credentialId) cred = mj.global.credentialId;
  } else {
    // legacy: try rooms/*/memory/members/*/principles.md — take newest as persona seed is done by migration writer;
    // for skeleton import we accept empty persona if not present.
    const legacyPersona = join(full, "persona", `${opts.name}.md`);
    if (existsSync(legacyPersona)) persona = readFileSync(legacyPersona, "utf-8");
  }

  const rec = createMember({
    name: opts.name,
    agentTemplate: template,
    credentialId: cred,
  });
  ensureMemorySkeleton(rec.id);
  if (persona.trim()) {
    writeMemoryLayer(rec.id, "persona", persona, { type: "user" }, { reason: "importFromArchive" });
  }
  return rec;
}
