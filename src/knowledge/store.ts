import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import type { KnowledgeBase, KnowledgeEntry } from "../shared/types.js";

const KNOWLEDGE_DIR = join(getBossmodeDir(), "knowledge");

function ensureKnowledgeDir(): void {
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

function kbDir(id: string): string {
  return join(KNOWLEDGE_DIR, id);
}

function kbJsonPath(id: string): string {
  return join(kbDir(id), "knowledge.json");
}

function entriesDir(kbId: string): string {
  return join(kbDir(kbId), "entries");
}

function entryPath(kbId: string, entryId: string): string {
  return join(entriesDir(kbId), `${entryId}.json`);
}

// -- Knowledge Base CRUD --

export function createKnowledgeBase(name: string, description: string): KnowledgeBase {
  ensureKnowledgeDir();
  const kb: KnowledgeBase = {
    id: randomUUID().slice(0, 8),
    name,
    description,
    createdAt: Date.now(),
  };
  const dir = kbDir(kb.id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(entriesDir(kb.id), { recursive: true });
  writeFileSync(kbJsonPath(kb.id), JSON.stringify(kb, null, 2), "utf-8");
  return kb;
}

export function listKnowledgeBases(): KnowledgeBase[] {
  ensureKnowledgeDir();
  const entries = readdirSync(KNOWLEDGE_DIR, { withFileTypes: true });
  const bases: KnowledgeBase[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jsonPath = kbJsonPath(entry.name);
    if (!existsSync(jsonPath)) continue;
    try {
      bases.push(JSON.parse(readFileSync(jsonPath, "utf-8")));
    } catch (err) { logger.error("knowledge-store", "failed to parse KB json", { id: entry.name, error: String(err) }); }
  }

  return bases.sort((a, b) => b.createdAt - a.createdAt);
}

export function getKnowledgeBase(id: string): KnowledgeBase | null {
  const jsonPath = kbJsonPath(id);
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, "utf-8"));
}

export function deleteKnowledgeBase(id: string): boolean {
  const dir = kbDir(id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// -- Knowledge Entry CRUD --

export function addEntry(kbId: string, title: string, content: string, source: string, type: "rule" | "knowledge" = "knowledge"): KnowledgeEntry {
  const dir = entriesDir(kbId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry: KnowledgeEntry = {
    id: randomUUID().slice(0, 8),
    title,
    content,
    source,
    type,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  writeFileSync(entryPath(kbId, entry.id), JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export function listEntries(kbId: string, filter?: { type?: "rule" | "knowledge" }): KnowledgeEntry[] {
  const dir = entriesDir(kbId);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let entries: KnowledgeEntry[] = [];

  for (const file of files) {
    try {
      const e = JSON.parse(readFileSync(join(dir, file), "utf-8")) as KnowledgeEntry;
      // Backfill type for old entries without it
      if (!e.type) e.type = "knowledge";
      entries.push(e);
    } catch (err) { logger.error("knowledge-store", "failed to parse entry", { kbId, file, error: String(err) }); }
  }

  if (filter?.type) entries = entries.filter((e) => e.type === filter.type);
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getEntry(kbId: string, entryId: string): KnowledgeEntry | null {
  const path = entryPath(kbId, entryId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function updateEntry(kbId: string, entryId: string, title: string, content: string): KnowledgeEntry | null {
  const path = entryPath(kbId, entryId);
  if (!existsSync(path)) return null;
  const existing = JSON.parse(readFileSync(path, "utf-8")) as KnowledgeEntry;
  const updated: KnowledgeEntry = { ...existing, title, content, updatedAt: Date.now() };
  writeFileSync(path, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export function deleteEntry(kbId: string, entryId: string): boolean {
  const path = entryPath(kbId, entryId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
