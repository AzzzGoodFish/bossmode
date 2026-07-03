import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import type { PromptSupplement, PromptSupplementMeta } from "../shared/types.js";

export type PromptSupplementScope = "room" | "member";

export interface PromptSupplementActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

interface PromptSupplementMetaFile {
  room?: PromptSupplementMeta;
  members?: Record<string, PromptSupplementMeta>;
}

interface PromptSupplementHistoryEvent {
  ts: number;
  scope: PromptSupplementScope;
  memberId?: string;
  revision: number;
  contentHash: string;
  contentLength: number;
  actorType: "user" | "member";
  actorMemberId?: string;
  actorName?: string;
  operation: "write" | "edit";
  note?: string;
}

export const PROMPT_SUPPLEMENT_MAX_CHARS = 20_000;
export const PROMPT_SUPPLEMENT_TEMPLATE = "## Rules\n\n## Core Knowledge\n\n## Working Notes\n\n## Linked Documents\n";

function roomDataDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId);
}

function supplementDir(roomId: string): string {
  return join(roomDataDir(roomId), "prompt-supplements");
}

function membersDir(roomId: string): string {
  return join(supplementDir(roomId), "members");
}

function metaPath(roomId: string): string {
  return join(supplementDir(roomId), "meta.json");
}

function historyPath(roomId: string): string {
  return join(supplementDir(roomId), "history.jsonl");
}

function contentPath(roomId: string, scope: PromptSupplementScope, memberId?: string): string {
  if (scope === "room") return join(supplementDir(roomId), "room.md");
  if (!memberId) throw new Error("memberId is required for member supplement");
  return join(membersDir(roomId), `${safeMemberId(memberId)}.md`);
}

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureSupplementDir(roomId: string): void {
  mkdirSync(membersDir(roomId), { recursive: true });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readMetaFile(roomId: string): PromptSupplementMetaFile {
  const path = metaPath(roomId);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PromptSupplementMetaFile;
  } catch {
    return {};
  }
}

function writeMetaFile(roomId: string, meta: PromptSupplementMetaFile): void {
  ensureSupplementDir(roomId);
  writeFileSync(metaPath(roomId), JSON.stringify(meta, null, 2), "utf-8");
}

function emptyMeta(content = ""): PromptSupplementMeta {
  return {
    revision: 0,
    contentHash: hashContent(content),
    contentLength: content.length,
  };
}

function getStoredMeta(meta: PromptSupplementMetaFile, scope: PromptSupplementScope, memberId?: string): PromptSupplementMeta | undefined {
  return scope === "room" ? meta.room : (memberId ? meta.members?.[memberId] : undefined);
}

function setStoredMeta(meta: PromptSupplementMetaFile, scope: PromptSupplementScope, next: PromptSupplementMeta, memberId?: string): PromptSupplementMetaFile {
  if (scope === "room") return { ...meta, room: next };
  if (!memberId) throw new Error("memberId is required for member supplement");
  return { ...meta, members: { ...(meta.members || {}), [memberId]: next } };
}

function assertContentSize(content: string): void {
  if (content.length > PROMPT_SUPPLEMENT_MAX_CHARS) {
    throw new Error(`Prompt supplement is too large (${content.length}/${PROMPT_SUPPLEMENT_MAX_CHARS} chars). Keep the full document in docs and link a summary here.`);
  }
}

function appendHistory(roomId: string, event: PromptSupplementHistoryEvent): void {
  ensureSupplementDir(roomId);
  appendFileSync(historyPath(roomId), JSON.stringify(event) + "\n", "utf-8");
}

export function readPromptSupplement(roomId: string, scope: PromptSupplementScope, memberId?: string): PromptSupplement {
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

export function writePromptSupplement(args: {
  roomId: string;
  scope: PromptSupplementScope;
  memberId?: string;
  content: string;
  actor: PromptSupplementActor;
  note?: string;
  operation?: "write" | "edit";
}): PromptSupplement {
  const content = String(args.content ?? "");
  assertContentSize(content);
  ensureSupplementDir(args.roomId);
  const current = readPromptSupplement(args.roomId, args.scope, args.memberId);
  const nextMeta: PromptSupplementMeta = {
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
    note: args.note,
  });
  return { content, ...nextMeta };
}

export function editPromptSupplement(args: {
  roomId: string;
  scope: PromptSupplementScope;
  memberId?: string;
  oldText: string;
  newText: string;
  actor: PromptSupplementActor;
  note?: string;
}): PromptSupplement {
  const oldText = String(args.oldText ?? "");
  if (!oldText) throw new Error("oldText is required");
  const current = readPromptSupplement(args.roomId, args.scope, args.memberId);
  const first = current.content.indexOf(oldText);
  if (first === -1) throw new Error("oldText was not found exactly once");
  if (current.content.indexOf(oldText, first + oldText.length) !== -1) throw new Error("oldText matched multiple times; make it more specific");
  const content = current.content.slice(0, first) + String(args.newText ?? "") + current.content.slice(first + oldText.length);
  return writePromptSupplement({ ...args, content, operation: "edit" });
}

export function getPromptSupplementSummary(roomId: string, memberId: string): { room: PromptSupplement; member: PromptSupplement } {
  return {
    room: readPromptSupplement(roomId, "room"),
    member: readPromptSupplement(roomId, "member", memberId),
  };
}
