/**
 * 0.20 member memory layers — persona (global) + per-scope principles/mainline.
 * Contract §6. Write tools enforce "write current scope only"; reads may cross scope.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { memberDir } from "./member-registry.js";
import { scopeDirName, parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import {
  AssetBudgetError,
  PRINCIPLES_TEMPLATE,
  computeAssetBudget,
  formatBudgetHeader,
} from "./principles-store.js";
import {
  MAINLINE_TEMPLATE,
} from "./mainline-store.js";
import { getMemoryBudget } from "./memory-budgets.js";

export type MemoryLayer = "persona" | "principles" | "mainline";

export interface MemoryActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

function memoryRoot(memberId: string): string {
  return join(memberDir(memberId), "memory");
}

function personaPath(memberId: string): string {
  return join(memoryRoot(memberId), "persona.md");
}

function scopeMemoryDir(memberId: string, scopeId: ScopeId): string {
  const ref = parseScopeId(scopeId);
  if (!ref) throw new Error("scope_not_found");
  return join(memoryRoot(memberId), "scopes", scopeDirName(ref));
}

function layerPath(memberId: string, layer: MemoryLayer, scopeId?: ScopeId): string {
  if (layer === "persona") return personaPath(memberId);
  if (!scopeId) throw new Error("scope_required");
  const base = scopeMemoryDir(memberId, scopeId);
  return join(base, layer === "principles" ? "principles.md" : "mainline.md");
}

function historyPath(memberId: string, layer: MemoryLayer, scopeId?: ScopeId): string {
  if (layer === "persona") return join(memoryRoot(memberId), "persona-history.jsonl");
  if (!scopeId) throw new Error("scope_required");
  return join(scopeMemoryDir(memberId, scopeId), `${layer}-history.jsonl`);
}

function templateFor(layer: MemoryLayer): string {
  if (layer === "mainline") return MAINLINE_TEMPLATE;
  return PRINCIPLES_TEMPLATE;
}

function budgetLimit(layer: MemoryLayer): number {
  if (layer === "mainline") return getMemoryBudget("mainline");
  if (layer === "persona") return getMemoryBudget("persona");
  return getMemoryBudget("memberPrinciples");
}

function ensureParent(filePath: string): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readMemoryLayer(
  memberId: string,
  layer: MemoryLayer,
  scopeId?: ScopeId,
): { content: string; meta: { length: number; budget: ReturnType<typeof computeAssetBudget> } } {
  const p = layerPath(memberId, layer, scopeId);
  const content = existsSync(p) ? readFileSync(p, "utf-8") : "";
  const limit = budgetLimit(layer);
  const budget = computeAssetBudget(content.length, limit);
  return { content, meta: { length: content.length, budget } };
}

export function writeMemoryLayer(
  memberId: string,
  layer: MemoryLayer,
  content: string,
  actor: MemoryActor,
  opts: { scopeId?: ScopeId; reason?: string; operation?: "write" | "edit" } = {},
): { content: string } {
  const limit = budgetLimit(layer);
  const budget = computeAssetBudget(content.length, limit);
  if (budget.overLimit) {
    const current = readMemoryLayer(memberId, layer, opts.scopeId).content;
    throw new AssetBudgetError({
      assetLabel: `member ${layer}`,
      attemptedLength: content.length,
      currentContent: current,
      budget: computeAssetBudget(current.length, limit),
    });
  }

  const p = layerPath(memberId, layer, opts.scopeId);
  ensureParent(p);
  writeFileSync(p, content, "utf-8");

  const hp = historyPath(memberId, layer, opts.scopeId);
  ensureParent(hp);
  const event = {
    ts: Date.now(),
    layer,
    scopeId: opts.scopeId,
    contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
    contentLength: content.length,
    actorType: actor.type,
    actorMemberId: actor.memberId,
    actorName: actor.name,
    operation: opts.operation || "write",
    reason: opts.reason || "",
    content,
  };
  appendFileSync(hp, JSON.stringify(event) + "\n", "utf-8");
  return { content };
}

/** Exact-text replacement edit — oldText must occur exactly once. */
export function editMemoryLayer(
  memberId: string,
  layer: MemoryLayer,
  oldText: string,
  newText: string,
  actor: MemoryActor,
  opts: { scopeId?: ScopeId; reason?: string } = {},
): { content: string } {
  if (!oldText) throw new Error("oldText is required");
  const current = readMemoryLayer(memberId, layer, opts.scopeId).content;
  const first = current.indexOf(oldText);
  if (first === -1) throw new Error("oldText not found in current content");
  if (current.indexOf(oldText, first + 1) !== -1) throw new Error("oldText must occur exactly once");
  const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
  return writeMemoryLayer(memberId, layer, next, actor, { ...opts, operation: "edit" });
}

/** Ensure skeleton files exist (empty templates) for a member + optional scope. */
export function ensureMemorySkeleton(memberId: string, scopeId?: ScopeId): void {
  const root = memoryRoot(memberId);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const persona = personaPath(memberId);
  if (!existsSync(persona)) {
    ensureParent(persona);
    writeFileSync(persona, "", "utf-8");
  }
  if (scopeId) {
    for (const layer of ["principles", "mainline"] as const) {
      const p = layerPath(memberId, layer, scopeId);
      if (!existsSync(p)) {
        ensureParent(p);
        writeFileSync(p, templateFor(layer), "utf-8");
      }
    }
  }
}

export function formatMemoryBudgetHeader(layer: MemoryLayer, contentLength: number): string {
  return formatBudgetHeader(computeAssetBudget(contentLength, budgetLimit(layer)));
}

export interface MemoryLayerInfo {
  content: string;
  revision: number;
  contentHash: string;
  contentLength: number;
  updatedAt: number | null;
  updatedBy: "user" | "member" | null;
  updatedByMemberId?: string;
  updatedByName?: string;
  budget: ReturnType<typeof computeAssetBudget>;
}

interface MemoryHistoryEvent {
  ts?: number;
  actorType?: "user" | "member";
  actorMemberId?: string;
  actorName?: string;
}

/**
 * Read a layer with revision/audit metadata synthesized from its history log
 * (revision = number of persisted write events; last event carries writer + ts).
 * This is the read shape the memory tools and member-asset APIs expose.
 */
export function readMemoryLayerInfo(memberId: string, layer: MemoryLayer, scopeId?: ScopeId): MemoryLayerInfo {
  const { content, meta } = readMemoryLayer(memberId, layer, scopeId);
  const hp = historyPath(memberId, layer, scopeId);
  const events = existsSync(hp)
    ? parseJsonlLines<MemoryHistoryEvent>(readFileSync(hp, "utf-8"), {
        category: "member-memory-store",
        context: { memberId, layer, scopeId },
      })
    : [];
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  return {
    content,
    revision: events.length,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    contentLength: content.length,
    updatedAt: last?.ts ?? null,
    updatedBy: last?.actorType ?? null,
    updatedByMemberId: last?.actorMemberId,
    updatedByName: last?.actorName,
    budget: meta.budget,
  };
}
