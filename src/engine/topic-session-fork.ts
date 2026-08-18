/**
 * Topic batch 2 — prefix-fork a room session into a topic session file.
 * plan-topic-threads-v1 §2.2: borrow SessionManager file-layer primitives
 * (open + createBranchedSession) so the room instance is never replaced.
 *
 * Degradation: no room session / empty / fork failure → { mode: "fresh" }.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "../foundation/logger.js";
import { getSessions } from "../workspace/session-store.js";
import { roomDir } from "../workspace/room-store.js";
import type { TopicSeedMode } from "../workspace/topic-store.js";

export interface TopicForkResult {
  mode: TopicSeedMode;
  sessionFile?: string;
  sessionId?: string;
  /** Extractive prefix summary used in the topic guide. */
  prefixSummary: string;
  reason?: string;
}

function topicSessionsPath(parentRoomId: string, topicId: string): string {
  return join(roomDir(parentRoomId), "topics", topicId, "sessions.json");
}

export function saveTopicSession(
  parentRoomId: string,
  topicId: string,
  memberId: string,
  session: { sessionId?: string; sessionFile?: string },
): void {
  const path = topicSessionsPath(parentRoomId, topicId);
  mkdirSync(dirname(path), { recursive: true });
  let all: Record<string, { sessionId?: string; sessionFile?: string }> = {};
  try {
    if (existsSync(path)) all = JSON.parse(readFileSync(path, "utf-8"));
  } catch { /* start empty */ }
  all[memberId] = session;
  writeFileSync(path, JSON.stringify(all, null, 2), "utf-8");
}

export function getTopicSession(
  parentRoomId: string,
  topicId: string,
  memberId: string,
): { sessionId?: string; sessionFile?: string } | undefined {
  const path = topicSessionsPath(parentRoomId, topicId);
  if (!existsSync(path)) return undefined;
  try {
    const all = JSON.parse(readFileSync(path, "utf-8"));
    return all[memberId];
  } catch {
    return undefined;
  }
}

function userTextFromEntry(entry: any): string {
  const msg = entry?.message;
  if (!msg) return "";
  if (msg.role !== "user") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && (c.type === "text" || typeof c.text === "string"))
    .map((c: any) => String(c.text || c))
    .join("\n");
}

/**
 * Pick the session entry to fork from:
 * 1. last user-message entry whose text contains the anchor excerpt
 * 2. else last user-message entry (architect: 找不着=锚点之前最后一条 user message)
 * 3. else leaf id
 */
export function pickForkLeafId(entries: any[], anchorExcerpt?: string): string | null {
  const users = entries.filter((e) => e?.type === "message" && e.message?.role === "user" && e.id);
  if (users.length === 0) {
    const last = [...entries].reverse().find((e) => e?.id && e.type !== "session");
    return last?.id ?? null;
  }
  const needle = String(anchorExcerpt || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (needle.length >= 8) {
    const hit = [...users].reverse().find((e) => userTextFromEntry(e).includes(needle));
    if (hit) return hit.id;
  }
  return users[users.length - 1].id;
}

/** Extractive summary of user turns on the forked prefix (no LLM). */
export function extractPrefixSummary(entries: any[], maxChars = 600): string {
  const bits: string[] = [];
  for (const e of entries) {
    if (e?.type !== "message") continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    const content = e.message?.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const tag = role === "user" ? "User" : "Assistant";
    bits.push(`${tag}: ${text.slice(0, 160)}`);
    if (bits.join(" | ").length >= maxChars) break;
  }
  const out = bits.join(" | ");
  if (!out) return "(no prior room turns in the forked prefix)";
  return out.length > maxChars ? out.slice(0, maxChars - 1) + "…" : out;
}

/**
 * Fork the member's room session prefix into a new topic session file.
 * Never mutates the room session.
 */
export function forkRoomSessionPrefix(args: {
  parentRoomId: string;
  topicId: string;
  memberId: string;
  cwd: string;
  seedMode: TopicSeedMode;
  anchorExcerpt?: string;
}): TopicForkResult {
  if (args.seedMode !== "fork") {
    return { mode: "fresh", prefixSummary: "", reason: "seedMode=fresh" };
  }

  const saved = getSessions(args.parentRoomId)[args.memberId];
  const sourceFile = saved?.sessionFile;
  if (!sourceFile || !existsSync(sourceFile)) {
    logger.info("topic", "fork degraded: no room session", {
      parentRoomId: args.parentRoomId,
      memberId: args.memberId,
      topicId: args.topicId,
    });
    return { mode: "fresh", prefixSummary: "", reason: "no-room-session" };
  }

  try {
    const source = SessionManager.open(sourceFile, dirname(sourceFile), args.cwd);
    const entries = typeof source.getEntries === "function" ? source.getEntries() : [];
    const leafId = pickForkLeafId(entries, args.anchorExcerpt);
    if (!leafId) {
      return { mode: "fresh", prefixSummary: "", reason: "no-forkable-entry" };
    }

    const sessionDir = join(roomDir(args.parentRoomId), "topics", args.topicId, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    // forkFrom writes a NEW file under sessionDir (room file untouched).
    // branch(leafId) moves the leaf so the next turn continues from the anchor
    // prefix; existing later entries stay on disk but are off the active path.
    const forked = SessionManager.forkFrom(sourceFile, args.cwd, sessionDir);
    const forkedPath = forked.getSessionFile?.() || (forked as any).sessionFile;
    if (!forkedPath || !existsSync(forkedPath)) {
      return { mode: "fresh", prefixSummary: "", reason: "fork-write-failed" };
    }
    try {
      if (leafId && typeof forked.branch === "function") forked.branch(leafId);
    } catch (branchErr) {
      logger.warn("topic", "fork branch(leaf) failed; keeping full copy", {
        leafId, error: String(branchErr),
      });
    }

    // Prefix for summary: path from root to leaf.
    const prefixEntries = typeof source.getBranch === "function" ? source.getBranch(leafId) : entries;
    const prefixSummary = extractPrefixSummary(prefixEntries);

    let sessionId: string | undefined;
    try {
      const opened = SessionManager.open(forkedPath, sessionDir, args.cwd);
      sessionId = opened.getSessionId?.();
    } catch { /* optional */ }

    saveTopicSession(args.parentRoomId, args.topicId, args.memberId, {
      sessionId,
      sessionFile: forkedPath,
    });

    logger.info("topic", "forked room session prefix", {
      parentRoomId: args.parentRoomId,
      topicId: args.topicId,
      memberId: args.memberId,
      leafId,
      sessionFile: forkedPath,
    });
    return { mode: "fork", sessionFile: forkedPath, sessionId, prefixSummary };
  } catch (err) {
    logger.warn("topic", "fork failed, degrading to fresh", {
      parentRoomId: args.parentRoomId,
      topicId: args.topicId,
      memberId: args.memberId,
      error: String(err),
    });
    return { mode: "fresh", prefixSummary: "", reason: `fork-error:${String(err)}` };
  }
}
