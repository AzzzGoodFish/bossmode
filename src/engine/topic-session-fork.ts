/**
 * Topic batch 2 — prefix-fork a room session into a topic session file.
 * plan-topic-threads-v1 §2.2: borrow SessionManager file-layer primitives
 * (open + forkFrom + branch) so the room instance is never replaced.
 *
 * Only absent/unforkable sources degrade to fresh. Failed forks remain visible.
 */
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "../foundation/logger.js";
import { getCurrentSession, mainSessionDirectory, saveCurrentSession } from "../workspace/session-store.js";
import { SdkExecutionService } from "../services/sdk-execution-service.js";
import type { TopicSeedMode } from "../workspace/topic-store.js";

export interface TopicForkResult {
  mode: TopicSeedMode;
  sessionFile?: string;
  sessionId?: string;
  /** The cut manager is handed to the first topic activation without re-open. */
  sessionManager?: SessionManager;
  /** Extractive prefix summary used in the topic guide. */
  prefixSummary: string;
  reason?: string;
}

export function saveTopicSession(
  parentRoomId: string,
  topicId: string,
  memberId: string,
  session: { sessionId?: string; sessionFile?: string },
): void {
  void parentRoomId; // scope identity is topic-owned; room history is not an archive dependency.
  saveCurrentSession(memberId, `topic:${topicId}`, { runtime: "pi-sdk", ...session });
}

export function getTopicSession(
  parentRoomId: string,
  topicId: string,
  memberId: string,
): { sessionId?: string; sessionFile?: string } | undefined {
  void parentRoomId;
  return getCurrentSession(memberId, `topic:${topicId}`);
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

  const saved = getCurrentSession(args.memberId, `room:${args.parentRoomId}`);
  const sourceFile = saved?.sessionFile;
  if (!sourceFile || !existsSync(sourceFile)) {
    logger.info("topic", "fork degraded: no room session", {
      parentRoomId: args.parentRoomId,
      memberId: args.memberId,
      topicId: args.topicId,
    });
    return { mode: "fresh", prefixSummary: "", reason: "no-room-session" };
  }

  const sessionDir = mainSessionDirectory(args.memberId, `topic:${args.topicId}`);
  // An ID supplied through the public SDK API makes a partial fork discoverable
  // from durable provenance if forkFrom throws before returning its manager.
  const forkSessionId = randomUUID();
  const attempt = new SdkExecutionService(args.memberId, `topic:${args.topicId}`).dispatch(
    "session-fork", JSON.stringify({ operation: "pi-sdk:SessionManager.forkFrom",
      sourceFile, sourceSessionId: saved?.sessionId, parentRoomId: args.parentRoomId,
      sessionDir, forkSessionId, anchorExcerpt: args.anchorExcerpt }),
  );
  let forkedPath: string | undefined;
  try {
    const source = SessionManager.open(sourceFile, dirname(sourceFile), args.cwd);
    const entries = source.getEntries();
    const leafId = pickForkLeafId(entries, args.anchorExcerpt);
    if (!leafId) {
      attempt.interrupt("No forkable source entry; fresh fallback selected");
      return { mode: "fresh", prefixSummary: "", reason: "no-forkable-entry" };
    }
    const prefixEntries = source.getBranch(leafId);
    mkdirSync(sessionDir, { recursive: true });

    // The SDK alone writes the new archive. Keep its in-memory branch cut:
    // reopening before the next append would restore the original file leaf.
    const forked = SessionManager.forkFrom(sourceFile, args.cwd, sessionDir, { id: forkSessionId });
    forkedPath = forked.getSessionFile();
    const sessionId = forked.getSessionId();
    if (!forkedPath || forkedPath === sourceFile || !existsSync(forkedPath)
      || sessionId !== forkSessionId || sessionId === source.getSessionId()
      || forked.getHeader()?.parentSession !== sourceFile) {
      throw new Error("Fork file or SDK identity verification failed");
    }
    forked.branch(leafId);
    if (forked.getLeafId() !== leafId
      || JSON.stringify(forked.getBranch()) !== JSON.stringify(prefixEntries)) {
      throw new Error("Fork prefix branch verification failed");
    }
    const prefixSummary = extractPrefixSummary(prefixEntries);
    saveTopicSession(args.parentRoomId, args.topicId, args.memberId, { sessionId, sessionFile: forkedPath });
    const associated = getTopicSession(args.parentRoomId, args.topicId, args.memberId);
    if (associated?.sessionId !== sessionId || associated.sessionFile !== forkedPath) {
      throw new Error("Fork session association verification failed");
    }
    attempt.settle();
    logger.info("topic", "forked room session prefix", {
      parentRoomId: args.parentRoomId, topicId: args.topicId, memberId: args.memberId,
      leafId, sessionFile: forkedPath, attemptId: attempt.id,
    });
    return { mode: "fork", sessionFile: forkedPath, sessionId, sessionManager: forked, prefixSummary };
  } catch (error) {
    // Never erase a partial SDK artifact or turn SQL/branch failures into a
    // successful fresh session. The dispatched reference survives a crash too.
    return attempt.fail(new Error(`Topic prefix fork failed (attempt=${attempt.id}, sessionId=${forkSessionId}, directory=${sessionDir}, file=${forkedPath ?? "not returned"}): ${String(error)}`, { cause: error }));
  }
}
