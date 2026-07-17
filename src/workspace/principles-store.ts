import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import type { Principles, PrinciplesMeta, PromptAssetBudget } from "../shared/types.js";

export type PrinciplesScope = "room" | "member";

export interface PrinciplesActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

interface PrinciplesMetaFile {
  room?: PrinciplesMeta;
  members?: Record<string, PrinciplesMeta>;
}

interface PrinciplesHistoryEvent {
  ts: number;
  scope: PrinciplesScope;
  memberId?: string;
  revision: number;
  contentHash: string;
  contentLength: number;
  actorType: "user" | "member";
  actorMemberId?: string;
  actorName?: string;
  operation: "write" | "edit";
  reason: string;
  /** Full content snapshot of this revision (stored from day one so a future revert is zero-migration). */
  content: string;
}

export const PRINCIPLES_MEMBER_MAX_CHARS = 4_000;
export const PRINCIPLES_ROOM_MAX_CHARS = 8_000;
export const PRINCIPLES_TEMPLATE = "## Rules\n\n## Core Knowledge\n\n## Working Notes\n\n## Linked Documents\n";

export function principlesBudgetLimit(scope: PrinciplesScope): number {
  return scope === "room" ? PRINCIPLES_ROOM_MAX_CHARS : PRINCIPLES_MEMBER_MAX_CHARS;
}

function formatThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function computeAssetBudget(contentLength: number, limit: number): PromptAssetBudget {
  return {
    limit,
    usage: contentLength,
    pct: Math.round((contentLength * 100) / limit),
    overLimit: contentLength > limit,
  };
}

export function formatBudgetHeader(budget: PromptAssetBudget): string {
  const base = `${budget.pct}% — ${formatThousands(budget.usage)}/${formatThousands(budget.limit)}`;
  return budget.overLimit
    ? `${base} · over budget — pending curation (writes are rejected until within budget)`
    : base;
}

/** Error thrown when a write/edit would exceed the asset budget. Carries the current
 *  full content so the caller can curate (merge/delete) in the same turn and retry. */
export class AssetBudgetError extends Error {
  readonly currentContent: string;
  readonly budget: PromptAssetBudget;
  readonly attemptedLength: number;
  constructor(args: { assetLabel: string; attemptedLength: number; currentContent: string; budget: PromptAssetBudget }) {
    const header = `${args.assetLabel} would exceed its budget (${formatThousands(args.attemptedLength)}/${formatThousands(args.budget.limit)} chars). `
      + `Curate now: merge or delete entries in this same turn, then retry the write. `
      + `Current content (${formatThousands(args.budget.usage)} chars${args.budget.overLimit ? ", already over budget — pending curation" : ""}):\n\n${args.currentContent}`;
    super(header);
    this.name = "AssetBudgetError";
    this.currentContent = args.currentContent;
    this.budget = args.budget;
    this.attemptedLength = args.attemptedLength;
  }
}

function roomDataDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId);
}

// Storage directory and file format are intentionally unchanged from the former
// prompt-supplement layout (see plan-prompt-asset-model-and-governance §5).
function principlesDir(roomId: string): string {
  return join(roomDataDir(roomId), "prompt-supplements");
}

function membersDir(roomId: string): string {
  return join(principlesDir(roomId), "members");
}

function metaPath(roomId: string): string {
  return join(principlesDir(roomId), "meta.json");
}

function historyPath(roomId: string): string {
  return join(principlesDir(roomId), "history.jsonl");
}

function contentPath(roomId: string, scope: PrinciplesScope, memberId?: string): string {
  if (scope === "room") return join(principlesDir(roomId), "room.md");
  if (!memberId) throw new Error("memberId is required for member principles");
  return join(membersDir(roomId), `${safeMemberId(memberId)}.md`);
}

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensurePrinciplesDir(roomId: string): void {
  mkdirSync(membersDir(roomId), { recursive: true });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readMetaFile(roomId: string): PrinciplesMetaFile {
  const path = metaPath(roomId);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PrinciplesMetaFile;
  } catch {
    return {};
  }
}

function writeMetaFile(roomId: string, meta: PrinciplesMetaFile): void {
  ensurePrinciplesDir(roomId);
  writeFileSync(metaPath(roomId), JSON.stringify(meta, null, 2), "utf-8");
}

function emptyMeta(content = ""): PrinciplesMeta {
  return {
    revision: 0,
    contentHash: hashContent(content),
    contentLength: content.length,
  };
}

function getStoredMeta(meta: PrinciplesMetaFile, scope: PrinciplesScope, memberId?: string): PrinciplesMeta | undefined {
  return scope === "room" ? meta.room : (memberId ? meta.members?.[memberId] : undefined);
}

function setStoredMeta(meta: PrinciplesMetaFile, scope: PrinciplesScope, next: PrinciplesMeta, memberId?: string): PrinciplesMetaFile {
  if (scope === "room") return { ...meta, room: next };
  if (!memberId) throw new Error("memberId is required for member principles");
  return { ...meta, members: { ...(meta.members || {}), [memberId]: next } };
}

function appendHistory(roomId: string, event: PrinciplesHistoryEvent): void {
  ensurePrinciplesDir(roomId);
  appendFileSync(historyPath(roomId), JSON.stringify(event) + "\n", "utf-8");
}

export function readPrinciples(roomId: string, scope: PrinciplesScope, memberId?: string): Principles {
  const path = contentPath(roomId, scope, memberId);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const stored = getStoredMeta(readMetaFile(roomId), scope, memberId);
  const fallback = emptyMeta(content);
  const meta = stored || fallback;
  return {
    content,
    revision: meta.revision ?? 0,
    contentHash: meta.contentHash || fallback.contentHash,
    contentLength: meta.contentLength ?? content.length,
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
    updatedByMemberId: meta.updatedByMemberId,
    updatedByName: meta.updatedByName,
  };
}

export function readPrinciplesWithBudget(roomId: string, scope: PrinciplesScope, memberId?: string): Principles & { budget: PromptAssetBudget } {
  const principles = readPrinciples(roomId, scope, memberId);
  return { ...principles, budget: computeAssetBudget(principles.content.length, principlesBudgetLimit(scope)) };
}

export function writePrinciples(args: {
  roomId: string;
  scope: PrinciplesScope;
  memberId?: string;
  content: string;
  actor: PrinciplesActor;
  reason: string;
  operation?: "write" | "edit";
}): Principles {
  const content = String(args.content ?? "");
  const reason = String(args.reason ?? "").trim();
  if (!reason) throw new Error("reason is required — record the source of this change (user feedback, a decision, or curation)");
  const limit = principlesBudgetLimit(args.scope);
  const current = readPrinciples(args.roomId, args.scope, args.memberId);
  if (content.length > limit) {
    throw new AssetBudgetError({
      assetLabel: `${args.scope} principles`,
      attemptedLength: content.length,
      currentContent: current.content,
      budget: computeAssetBudget(current.content.length, limit),
    });
  }
  ensurePrinciplesDir(args.roomId);
  const nextMeta: PrinciplesMeta = {
    revision: current.revision + 1,
    contentHash: hashContent(content),
    contentLength: content.length,
    updatedAt: Date.now(),
    updatedBy: args.actor.type,
    updatedByMemberId: args.actor.memberId,
    updatedByName: args.actor.name,
  };
  writeFileSync(contentPath(args.roomId, args.scope, args.memberId), content, "utf-8");
  writeMetaFile(args.roomId, setStoredMeta(readMetaFile(args.roomId), args.scope, nextMeta, args.memberId));
  appendHistory(args.roomId, {
    ts: nextMeta.updatedAt!,
    scope: args.scope,
    memberId: args.scope === "member" ? args.memberId : undefined,
    revision: nextMeta.revision,
    contentHash: nextMeta.contentHash,
    contentLength: nextMeta.contentLength,
    actorType: args.actor.type,
    actorMemberId: args.actor.memberId,
    actorName: args.actor.name,
    operation: args.operation || "write",
    reason,
    content,
  });
  return { content, ...nextMeta };
}

export function editPrinciples(args: {
  roomId: string;
  scope: PrinciplesScope;
  memberId?: string;
  oldText: string;
  newText: string;
  actor: PrinciplesActor;
  reason: string;
}): Principles {
  const oldText = String(args.oldText ?? "");
  if (!oldText) throw new Error("oldText is required");
  const current = readPrinciples(args.roomId, args.scope, args.memberId);
  const first = current.content.indexOf(oldText);
  if (first === -1) throw new Error("oldText was not found exactly once");
  if (current.content.indexOf(oldText, first + oldText.length) !== -1) throw new Error("oldText matched multiple times; make it more specific");
  const content = current.content.slice(0, first) + String(args.newText ?? "") + current.content.slice(first + oldText.length);
  return writePrinciples({ ...args, content, operation: "edit" });
}

export function getPrinciplesSummary(roomId: string, memberId: string): { room: Principles; member: Principles } {
  return {
    room: readPrinciples(roomId, "room"),
    member: readPrinciples(roomId, "member", memberId),
  };
}
