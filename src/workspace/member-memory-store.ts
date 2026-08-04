/**
 * 0.20 member memory layers — persona (global) + per-scope principles/mainline.
 * Contract §6. Write tools enforce "write current scope only"; reads may cross scope.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { memberDir } from "./member-registry.js";
import { scopeDirName, parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import {
  AssetBudgetError,
  PRINCIPLES_MEMBER_MAX_CHARS,
  PRINCIPLES_TEMPLATE,
  computeAssetBudget,
  formatBudgetHeader,
} from "./principles-store.js";
import {
  MAINLINE_MAX_CHARS,
  MAINLINE_TEMPLATE,
} from "./mainline-store.js";

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
  if (layer === "mainline") return MAINLINE_MAX_CHARS;
  return PRINCIPLES_MEMBER_MAX_CHARS;
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
