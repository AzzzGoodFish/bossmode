// Mainline (主线) store — member-level runtime-layer prompt asset.
// Single markdown file, two sections: `## 焦点` (domain cornerstones) and
// `## 动态索引` (pinned refs: docs/..., task:<id>, msg:#<seq>).
// The index stores pointers only — chat/tasks/docs remain the source of truth.
// References are resolved at read/inject time; unresolvable lines are honestly
// marked `[stale]`, never silently deleted.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import type { Mainline, MainlineIndexEntry, ParsedMainline, PrinciplesMeta, PromptAssetBudget } from "../shared/types.js";
import { getTask } from "./task-store.js";
import { readAllMessages } from "./message-store.js";
import { entryExists } from "../knowledge/store.js";
import { AssetBudgetError, computeAssetBudget } from "./principles-store.js";

export { AssetBudgetError };

export interface MainlineActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

interface MainlineMetaFile {
  members?: Record<string, PrinciplesMeta>;
}

interface MainlineHistoryEvent {
  ts: number;
  memberId: string;
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

export const MAINLINE_MAX_CHARS = 4_000;
export const MAINLINE_TEMPLATE = "## 焦点\n\n\n\n## 动态索引\n\n";

export const MAINLINE_FOCUS_HEADING = "## 焦点";
export const MAINLINE_INDEX_HEADING = "## 动态索引";

function mainlinesDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "mainlines");
}

function membersDir(roomId: string): string {
  return join(mainlinesDir(roomId), "members");
}

function metaPath(roomId: string): string {
  return join(mainlinesDir(roomId), "meta.json");
}

function historyPath(roomId: string): string {
  return join(mainlinesDir(roomId), "history.jsonl");
}

function contentPath(roomId: string, memberId: string): string {
  return join(membersDir(roomId), `${safeMemberId(memberId)}.md`);
}

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureMainlinesDir(roomId: string): void {
  mkdirSync(membersDir(roomId), { recursive: true });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readMetaFile(roomId: string): MainlineMetaFile {
  const path = metaPath(roomId);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MainlineMetaFile;
  } catch {
    return {};
  }
}

function writeMetaFile(roomId: string, meta: MainlineMetaFile): void {
  ensureMainlinesDir(roomId);
  writeFileSync(metaPath(roomId), JSON.stringify(meta, null, 2), "utf-8");
}

function appendHistory(roomId: string, event: MainlineHistoryEvent): void {
  ensureMainlinesDir(roomId);
  appendFileSync(historyPath(roomId), JSON.stringify(event) + "\n", "utf-8");
}

export function readMainline(roomId: string, memberId: string): Mainline {
  const path = contentPath(roomId, memberId);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const stored = readMetaFile(roomId).members?.[memberId];
  return {
    content,
    revision: stored?.revision ?? 0,
    contentHash: stored?.contentHash || hashContent(content),
    contentLength: stored?.contentLength ?? content.length,
    updatedAt: stored?.updatedAt,
    updatedBy: stored?.updatedBy,
    updatedByMemberId: stored?.updatedByMemberId,
    updatedByName: stored?.updatedByName,
  };
}

export function readMainlineWithBudget(roomId: string, memberId: string): Mainline & { budget: PromptAssetBudget } {
  const mainline = readMainline(roomId, memberId);
  return { ...mainline, budget: computeAssetBudget(mainline.content.length, MAINLINE_MAX_CHARS) };
}

export function writeMainline(args: {
  roomId: string;
  memberId: string;
  content: string;
  actor: MainlineActor;
  reason: string;
  operation?: "write" | "edit";
}): Mainline {
  const content = String(args.content ?? "");
  const reason = String(args.reason ?? "").trim();
  if (!reason) throw new Error("reason is required — record the source of this change (user feedback, a decision, or curation)");
  const current = readMainline(args.roomId, args.memberId);
  if (content.length > MAINLINE_MAX_CHARS) {
    throw new AssetBudgetError({
      assetLabel: "member mainline",
      attemptedLength: content.length,
      currentContent: current.content,
      budget: computeAssetBudget(current.content.length, MAINLINE_MAX_CHARS),
    });
  }
  ensureMainlinesDir(args.roomId);
  const nextMeta: PrinciplesMeta = {
    revision: current.revision + 1,
    contentHash: hashContent(content),
    contentLength: content.length,
    updatedAt: Date.now(),
    updatedBy: args.actor.type,
    updatedByMemberId: args.actor.memberId,
    updatedByName: args.actor.name,
  };
  writeFileSync(contentPath(args.roomId, args.memberId), content, "utf-8");
  const meta = readMetaFile(args.roomId);
  writeMetaFile(args.roomId, { ...meta, members: { ...(meta.members || {}), [args.memberId]: nextMeta } });
  appendHistory(args.roomId, {
    ts: nextMeta.updatedAt!,
    memberId: args.memberId,
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

export function editMainline(args: {
  roomId: string;
  memberId: string;
  oldText: string;
  newText: string;
  actor: MainlineActor;
  reason: string;
}): Mainline {
  const oldText = String(args.oldText ?? "");
  if (!oldText) throw new Error("oldText is required");
  const current = readMainline(args.roomId, args.memberId);
  const first = current.content.indexOf(oldText);
  if (first === -1) throw new Error("oldText was not found exactly once");
  if (current.content.indexOf(oldText, first + oldText.length) !== -1) throw new Error("oldText matched multiple times; make it more specific");
  const content = current.content.slice(0, first) + String(args.newText ?? "") + current.content.slice(first + oldText.length);
  return writeMainline({ ...args, content, operation: "edit" });
}

// ── Reference resolution (read/inject time) ──

const LIST_ITEM_RE = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/;
const STALE_MARK = "[stale]";

type RefToken =
  | { kind: "docs"; path: string }
  | { kind: "task"; id: string }
  | { kind: "msg-seq"; seq: number }
  | { kind: "msg-id"; id: string };

/** Extract the leading reference token of an index line body, if it looks like one. */
export function parseIndexRef(body: string): { ref: RefToken; raw: string } | null {
  const token = body.trim().split(/\s+/)[0] || "";
  if (/^docs\/\S+$/.test(token)) return { ref: { kind: "docs", path: token }, raw: token };
  if (/^task:\S+$/.test(token)) return { ref: { kind: "task", id: token.slice("task:".length) }, raw: token };
  if (/^msg:#\d+$/.test(token)) return { ref: { kind: "msg-seq", seq: parseInt(token.slice("msg:#".length), 10) }, raw: token };
  if (/^msg:\S+$/.test(token)) return { ref: { kind: "msg-id", id: token.slice("msg:".length) }, raw: token };
  return null;
}

function resolveRef(ref: RefToken, ctx: { roomId: string; messages: ReturnType<typeof readAllMessages> }): boolean {
  switch (ref.kind) {
    case "docs": {
      const stripped = ref.path.replace(/^docs\//, "");
      return entryExists(stripped) || entryExists(ref.path);
    }
    case "task": {
      // Canonical task ids always carry the `task-` prefix; the ref's id part may be
      // written with it (`task:task-7bbf2d48`) or without (`task:7bbf2d48`) — same reference.
      const taskId = ref.id.startsWith("task-") ? ref.id : `task-${ref.id}`;
      return getTask(ctx.roomId, taskId) !== null;
    }
    case "msg-seq":
      return ctx.messages.some((m) => (m as { seq?: number }).seq === ref.seq);
    case "msg-id":
      return ctx.messages.some((m) => m.id === ref.id);
  }
}

/**
 * Parse a (stale-resolved) Mainline document into a structured view for API/UI:
 * focus text plus index entries with kind/ref/note/stale. Pure function — the
 * markdown file stays the only storage form.
 */
export function parseMainline(content: string): ParsedMainline {
  const lines = content.split("\n");
  let section: "focus" | "index" | null = null;
  const focusLines: string[] = [];
  const index: MainlineIndexEntry[] = [];

  for (const line of lines) {
    const heading = line.trim().match(/^##(?!#)\s*(.*)$/);
    if (heading) {
      const name = heading[1].trim();
      section = name === MAINLINE_FOCUS_HEADING.slice(2).trim() ? "focus" : name === MAINLINE_INDEX_HEADING.slice(2).trim() ? "index" : null;
      continue;
    }
    if (section === "focus") {
      focusLines.push(line);
      continue;
    }
    if (section !== "index") continue;
    const item = line.match(LIST_ITEM_RE);
    if (!item) continue;
    let body = item[2];
    let stale = false;
    if (body.startsWith(STALE_MARK)) {
      stale = true;
      body = body.slice(STALE_MARK.length).trimStart();
    }
    const parsed = parseIndexRef(body);
    if (!parsed) {
      if (body.trim()) index.push({ kind: "other", ref: "", note: body.trim(), stale, raw: body.trim() });
      continue;
    }
    const note = body.slice(body.indexOf(parsed.raw) + parsed.raw.length).replace(/^\s*—\s*/, "").trim();
    const kind = parsed.ref.kind === "docs" ? "doc" : parsed.ref.kind === "task" ? "task" : "msg";
    index.push({ kind, ref: parsed.raw, note, stale, raw: body.trim() });
  }
  return { focus: focusLines.join("\n").trim(), index };
}

/**
 * Return the content with every reference-looking line of the `## 动态索引` section
 * resolved: unresolvable refs are prefixed with `[stale]` (honest, never deleted);
 * refs that resolve again lose a stale mark left by an earlier read.
 */
export function resolveMainlineRefs(roomId: string, content: string): string {
  if (!content.includes(MAINLINE_INDEX_HEADING)) return content;
  const lines = content.split("\n");
  let inIndex = false;
  let messages: ReturnType<typeof readAllMessages> | null = null;
  const getMessages = () => (messages ??= readAllMessages(roomId));

  const out = lines.map((line) => {
    const heading = line.trim().match(/^##(?!#)\s*(.*)$/);
    if (heading) {
      inIndex = heading[1].trim() === MAINLINE_INDEX_HEADING.slice(2).trim();
      return line;
    }
    if (!inIndex) return line;
    const item = line.match(LIST_ITEM_RE);
    if (!item) return line;
    let [, marker, body] = item;
    // Re-resolve honestly: drop a stale mark from a previous read before evaluating.
    let hadStale = false;
    if (body.startsWith(STALE_MARK)) {
      hadStale = true;
      body = body.slice(STALE_MARK.length).trimStart();
    }
    const parsed = parseIndexRef(body);
    if (!parsed) return hadStale ? `${marker}${body}` : line;
    const ok = resolveRef(parsed.ref, { roomId, messages: getMessages() });
    if (ok) return `${marker}${body}`;
    return `${marker}${STALE_MARK} ${body}`;
  });
  return out.join("\n");
}
