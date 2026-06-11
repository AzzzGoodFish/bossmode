// Knowledge activity — surfaces agent doc writes (write/edit tools) into the room chat stream.
//
// Hooked from engine/event-handler.ts on tool_end events. When an agent's
// write/edit tool touches a file under the knowledge docs root, we post a
// `knowledge_event` system message so the room timeline stays the single
// source of truth ("记录自动成为沟通").
//
// Known limit: bash-driven writes are not detected (args are opaque).
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep, relative, isAbsolute, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { postMessage } from "../communication/message-bus.js";
import { logger } from "../foundation/logger.js";
import type { KnowledgeEventMeta } from "../shared/types.js";

function docsRoot(): string {
  return resolve(join(getBossmodeDir(), "knowledge", "docs"));
}

/** Dedup window: the same agent touching the same doc repeatedly (multi-edit
 *  sessions) should produce one card, not a stream of them. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentCards = new Map<string, number>(); // `${roomId}:${actor}:${relPath}` -> ts

function shouldEmit(key: string): boolean {
  const now = Date.now();
  const last = recentCards.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentCards.set(key, now);
  // Opportunistic cleanup
  if (recentCards.size > 500) {
    for (const [k, ts] of recentCards) {
      if (now - ts >= DEDUP_WINDOW_MS) recentCards.delete(k);
    }
  }
  return true;
}

/** Extract a display title: frontmatter title > first markdown heading > filename. */
function extractTitle(absPath: string, relPath: string): string {
  try {
    const raw = readFileSync(absPath, "utf-8").slice(0, 4000);
    const fmMatch = raw.match(/^---\r?\n[\s\S]*?^title\s*:\s*(.+)$/m);
    if (fmMatch) {
      let t = fmMatch[1].trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
      if (t) return t;
    }
    const headingMatch = raw.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();
  } catch {
    /* file may have been deleted right after */
  }
  const base = relPath.split("/").pop() || relPath;
  return base.replace(/\.md$/i, "");
}

/**
 * Inspect a finished tool call; if it wrote into the knowledge docs tree,
 * post a knowledge_event card into the room.
 */
export function maybeEmitKnowledgeActivity(
  roomId: string,
  agentName: string,
  toolName: string,
  args: unknown,
  isError: boolean,
  roomCwd?: string,
): void {
  if (isError) return;
  if (toolName !== "write" && toolName !== "edit") return;

  const rawPath = (args as any)?.path ?? (args as any)?.file_path;
  if (typeof rawPath !== "string" || !rawPath) return;

  const root = docsRoot();
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(roomCwd || process.cwd(), rawPath);
  if (abs !== root && !abs.startsWith(root + sep)) return;

  const relPath = relative(root, abs).split(sep).join("/");
  const key = `${roomId}:${agentName}:${relPath}`;
  if (!shouldEmit(key)) return;

  const title = extractTitle(abs, relPath);
  const verb = existsSync(abs) && toolName === "write" ? "更新了文档" : toolName === "edit" ? "修改了文档" : "写入了文档";
  const meta: KnowledgeEventMeta = { path: relPath, title, actor: agentName, tool: toolName as "write" | "edit" };

  try {
    postMessage(roomId, "system", `[Knowledge] ${agentName} ${verb}: **${title}**`, [], {
      type: "knowledge_event",
      knowledge_event_meta: meta,
    });
    logger.info("knowledge-activity", "card emitted", { roomId, agent: agentName, path: relPath });
  } catch (err) {
    logger.error("knowledge-activity", "emit failed", { roomId, error: String(err) });
  }
}

/** Test hook: clear dedup state. */
export function _resetDedup(): void {
  recentCards.clear();
}
