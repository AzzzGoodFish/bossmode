// Mainline store — member-level runtime-layer prompt memory asset.
// Single markdown file, two sections: `## Focus` (domain cornerstones) and
// `## Dynamic Index` (pinned refs: docs/..., msg:#<seq>).
// The index stores pointers only — chat/docs remain the source of truth.
// References are resolved at read/inject time; unresolvable lines are honestly
// marked `[stale]`, never silently deleted.
import { roomDir } from "../files/layout.js";
import { existsSync, readFileSync } from "node:fs";
import { documentContentMeta } from "../data/repositories/document-repository.js";
import { documentIdentity, readDocumentMeta, saveDocument } from "../member/assets/document-assets.js";
import { join } from "node:path";

import { getMemoryBudget } from "../member/memory/memory-budgets.js";
import type { Mainline, MainlineIndexEntry, ParsedMainline, PromptAssetBudget } from "../kernel/types.js";
import { logger } from "../kernel/logger.js";
import { readAllMessages } from "./message-store.js";
import { readAllDmMessages } from "./dm-message-store.js";
import { entryExists } from "../knowledge/store.js";
import { AssetBudgetError, computeAssetBudget } from "../member/memory/principles-store.js";

export { AssetBudgetError };

export interface MainlineActor {
  type: "user" | "member";
  memberId?: string;
  name?: string;
}

export const MAINLINE_MAX_CHARS = 4_000;
export const MAINLINE_TEMPLATE = "## Focus\n\n\n\n## Dynamic Index\n\n";

export const MAINLINE_FOCUS_HEADING = "## Focus";
export const MAINLINE_INDEX_HEADING = "## Dynamic Index";

function mainlinesDir(roomId: string): string {
  return join(roomDir(roomId), "memory");
}

function membersDir(roomId: string): string {
  return join(mainlinesDir(roomId), "members");
}

function memberDir(roomId: string, memberId: string): string {
  return join(membersDir(roomId), safeMemberId(memberId));
}

function contentPath(roomId: string, memberId: string): string {
  return join(memberDir(roomId, memberId), "mainline.md");
}

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function readMainline(roomId: string, memberId: string): Mainline {
  const path = contentPath(roomId, memberId);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const stored = readDocumentMeta(documentIdentity(path, "mainline", memberId, roomId));
  return {
    content,
    revision: stored?.revision ?? 0,
    contentHash: stored?.contentHash || documentContentMeta(content).contentHash,
    contentLength: stored?.contentLength ?? content.length,
    updatedAt: stored?.updatedAt,
    updatedBy: stored?.updatedBy,
    updatedByMemberId: stored?.updatedByMemberId,
    updatedByName: stored?.updatedByName,
  };
}

export function readMainlineWithBudget(roomId: string, memberId: string): Mainline & { budget: PromptAssetBudget } {
  const mainline = readMainline(roomId, memberId);
  const limit = getMemoryBudget("mainline");
  return { ...mainline, budget: computeAssetBudget(mainline.content.length, limit) };
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
  const limit = getMemoryBudget("mainline");
  if (content.length > limit) {
    throw new AssetBudgetError({
      assetLabel: "member mainline",
      attemptedLength: content.length,
      currentContent: current.content,
      budget: computeAssetBudget(current.content.length, limit),
    });
  }
  const nextMeta = saveDocument(documentIdentity(contentPath(args.roomId, args.memberId), "mainline", args.memberId, args.roomId),
    content, args.actor, { operation: args.operation || "write", reason });
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

/** Messages for a scope key — room:<id> reads the room stream; dm:<memberId>
 * reads the member's DM stream (which lives member-owned, not under the
 * phantom rooms/dm:<id> dir). One source for ref resolution + msg enrichment. */
export function loadScopeMessages(scopeKey: string): ReturnType<typeof readAllMessages> {
  if (scopeKey.startsWith("dm:")) {
    const memberId = scopeKey.slice("dm:".length);
    return readAllDmMessages(memberId);
  }
  return readAllMessages(scopeKey);
}

/** Map msg refs to {msgId, summary} for parse enrichment (msg entries only). */
export function buildMsgLookup(messages: ReturnType<typeof readAllMessages>): Map<string, { msgId: string; summary: string }> {
  const lookup = new Map<string, { msgId: string; summary: string }>();
  for (const m of messages) {
    const summary = (m.content || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (typeof (m as { seq?: number }).seq === "number") {
      lookup.set(`seq:${(m as { seq?: number }).seq}`, { msgId: m.id, summary });
    }
    lookup.set(`id:${m.id}`, { msgId: m.id, summary });
  }
  return lookup;
}

type RefToken =
  | { kind: "docs"; path: string }
  | { kind: "msg-seq"; seq: number }
  | { kind: "msg-id"; id: string };

/** Extract the leading reference token of an index line body, if it looks like one.
 * Loose msg forms (fish 2026-08-06): members write `msg:#n` / `msg:n` / `No.n` /
 * `#n` in natural language instead of the canonical `msg:#<seq>`. All forms are
 * recognized ONLY as the leading token of a ## Dynamic Index line — never in Focus
 * text, never mid-line — so ordinary prose can't be misread as a reference.
 * `msg:n` maps to seq (a numeric msg-id never exists; message ids are UUIDs). */
export function parseIndexRef(body: string): { ref: RefToken; raw: string } | null {
  const token = body.trim().split(/\s+/)[0] || "";
  if (/^docs\/\S+$/.test(token)) return { ref: { kind: "docs", path: token }, raw: token };
  if (/^msg:#\d+$/.test(token)) return { ref: { kind: "msg-seq", seq: parseInt(token.slice("msg:#".length), 10) }, raw: token };
  if (/^msg:\d+$/.test(token)) return { ref: { kind: "msg-seq", seq: parseInt(token.slice("msg:".length), 10) }, raw: token };
  if (/^No\.\d+$/.test(token)) return { ref: { kind: "msg-seq", seq: parseInt(token.slice("No.".length), 10) }, raw: token };
  if (/^#\d+$/.test(token)) return { ref: { kind: "msg-seq", seq: parseInt(token.slice(1), 10) }, raw: token };
  if (/^msg:\S+$/.test(token)) return { ref: { kind: "msg-id", id: token.slice("msg:".length) }, raw: token };
  return null;
}

function resolveRef(ref: RefToken, ctx: { roomId: string; messages: ReturnType<typeof readAllMessages> }): boolean {
  switch (ref.kind) {
    case "docs": {
      const stripped = ref.path.replace(/^docs\//, "");
      return entryExists(stripped) || entryExists(ref.path);
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
export function parseMainline(content: string, msgLookup?: Map<string, { msgId: string; summary: string }>): ParsedMainline {
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
    const kind = parsed.ref.kind === "docs" ? "doc" : "msg";
    let msgId: string | undefined;
    let summary: string | undefined;
    if (kind === "msg" && msgLookup) {
      const hit = parsed.ref.kind === "msg-seq"
        ? msgLookup.get(`seq:${parsed.ref.seq}`)
        : parsed.ref.kind === "msg-id" ? msgLookup.get(`id:${parsed.ref.id}`) : undefined;
      if (hit) {
        msgId = hit.msgId;
        summary = hit.summary;
      }
    }
    index.push({ kind, ref: parsed.raw, note, stale, raw: body.trim(), ...(msgId ? { msgId } : {}), ...(summary ? { summary } : {}) });
  }
  return { focus: focusLines.join("\n").trim(), index };
}

/**
 * Return the content with every reference-looking line of the `## Dynamic Index` section
 * resolved: unresolvable refs are prefixed with `[stale]` (honest, never deleted);
 * refs that resolve again lose a stale mark left by an earlier read.
 */
export function resolveMainlineRefs(roomId: string, content: string, preloaded?: ReturnType<typeof readAllMessages>): string {
  if (!content.includes(MAINLINE_INDEX_HEADING)) return content;
  const lines = content.split("\n");
  let inIndex = false;
  let messages: ReturnType<typeof readAllMessages> | null = preloaded ?? null;
  const getMessages = () => (messages ??= loadScopeMessages(roomId));

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
