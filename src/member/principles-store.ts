import { existsSync, readFileSync } from "node:fs";
import { documentContentMeta } from "../data/repositories/document-repository.js";
import { documentIdentity, readDocumentMeta, saveDocument } from "../workspace/document-assets.js";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { getMemoryBudget } from "./memory-budgets.js";
import type { Principles, PrinciplesMeta, PromptAssetBudget } from "../kernel/types.js";

export type PrinciplesScope = "room" | "member";

export interface PrinciplesActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

export const PRINCIPLES_MEMBER_MAX_CHARS = 4_000;
export const PRINCIPLES_ROOM_MAX_CHARS = 8_000;
export const PRINCIPLES_TEMPLATE = "## Rules\n\n## Core Knowledge\n\n## Working Notes\n\n## Linked Documents\n";

export function principlesBudgetLimit(scope: PrinciplesScope): number {
  return scope === "room" ? getMemoryBudget("roomPrinciples") : getMemoryBudget("memberPrinciples");
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

function memoryDir(roomId: string): string {
  return join(roomDataDir(roomId), "memory");
}

function membersDir(roomId: string): string {
  return join(memoryDir(roomId), "members");
}

function memberDir(roomId: string, memberId: string): string {
  return join(membersDir(roomId), safeMemberId(memberId));
}

function contentPath(roomId: string, scope: PrinciplesScope, memberId?: string): string {
  if (scope === "room") return join(memoryDir(roomId), "room-principles.md");
  if (!memberId) throw new Error("memberId is required for member principles");
  return join(memberDir(roomId, memberId), "principles.md");
}

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Hash and UTF-16 length use the same units as document budgets. */
export const computeContentMeta = documentContentMeta;

export function readPrinciples(roomId: string, scope: PrinciplesScope, memberId?: string): Principles {
  const path = contentPath(roomId, scope, memberId);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const stored = readDocumentMeta(documentIdentity(path, "principles", scope === "member" ? memberId : undefined, roomId));
  const fallback: PrinciplesMeta = { revision: 0, ...computeContentMeta(content) };
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
  const nextMeta = saveDocument(documentIdentity(contentPath(args.roomId, args.scope, args.memberId), "principles",
    args.scope === "member" ? args.memberId : undefined, args.roomId), content, args.actor,
    { operation: args.operation || "write", reason });
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
