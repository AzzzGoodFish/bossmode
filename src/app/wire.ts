import { onCatalogChanged } from "../config/catalog.js";
import { refreshAllInstanceModelRegistries } from "../agent/controls.js";
import { notifyMemberProfileChanged } from "../agent/instance.js";

/** Configuration reports changes; only the composition root connects them to execution. */
export function wireConfiguration(): () => void {
  return onCatalogChanged(async () => { await refreshAllInstanceModelRegistries(); });
}

import { onMemberProfileChanged } from "../member/profile.js";
import { setGlobalConfigPatchObserver } from "../member/identity.js";
import { markStaleMounts } from "../agent/instance.js";
import { broadcastMemberProfileChanged } from "./ws.js";

export function wireMemberProfiles(): () => void {
  const stopRuntime = onMemberProfileChanged(member => notifyMemberProfileChanged(member));
  const stopViews = onMemberProfileChanged(member => broadcastMemberProfileChanged({ memberId: member.id, name: member.name, title: member.title ?? null }));
  return () => { stopRuntime(); stopViews(); };
}

/** Stale-mount bookkeeping rides the config-patch transaction (failure rolls back together). */
export function wireMemberConfigPatches(): () => void {
  setGlobalConfigPatchObserver((id, fields) => markStaleMounts(id, fields));
  return () => setGlobalConfigPatchObserver(undefined);
}

import { connectConversationMembers } from "../chat/conversations.js";
import { readMemberIdentity } from "../member/identity.js";
export function wireConversationMembers(): () => void {
  return connectConversationMembers(readMemberIdentity);
}

import { loadEventsPaginated, memberTokenTotal, pageActivity, readStats, readUsageRows, setAgentEventSink, setToolActivityHook, setContextUsageRefreshHook } from "../agent/events.js";
import { abortAgent, abortMember, compactMember, compactMemberById, resetMemberSession, restartMember } from "../agent/controls.js";
import { setStatusSink } from "../agent/instance.js";
import { broadcastToAgentSubscribers, broadcastToRoom } from "./ws.js";
import { commitChatMessage, getAgentContextUsage, getAgentStatus, getMemberActiveTools, getMemberBusyState, getMemberInstances, getRoomAgentStatuses, getScopeLiveStatus, previewMemberPrompt, refreshContextUsage, setRuntimeViewSink } from "./member-actions.js";

// Knowledge activity — surfaces agent doc writes (write/edit tools) into the room chat stream.
// Connected through the agent tool-activity port; the room timeline stays the single source of
// truth ("记录自动成为沟通"). Known limit: bash-driven writes are not detected (args are opaque).
import { documentsRoot } from "../files/layout.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep, relative, isAbsolute } from "node:path";

import { logger } from "../kernel/logger.js";
import * as roomStore from "../chat/conversations.js";
import type { KnowledgeEventMeta } from "../kernel/types.js";

function docsRoot(): string {
  return resolve(documentsRoot());
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

/** Extract a display title: first markdown heading > filename. Frontmatter is plain content. */
function extractTitle(absPath: string, relPath: string): string {
  try {
    const raw = readFileSync(absPath, "utf-8").slice(0, 4000);
    const headingMatch = raw.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();
  } catch {
    /* file may have been deleted right after */
  }
  const base = relPath.split("/").pop() || relPath;
  return base.replace(/\.[^.]+$/i, "").replace(/[-_]/g, " ");
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
): void {
  if (isError) return;
  if (toolName !== "write" && toolName !== "edit") return;

  const rawPath = (args as any)?.path ?? (args as any)?.file_path;
  if (typeof rawPath !== "string" || !rawPath) return;

  const room = roomStore.getRoom(roomId);
  const root = docsRoot();
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(room?.cwd || process.cwd(), rawPath);
  if (abs !== root && !abs.startsWith(root + sep)) return;

  const relPath = relative(root, abs).split(sep).join("/");
  const key = `${roomId}:${agentName}:${relPath}`;
  if (!shouldEmit(key)) return;

  const title = extractTitle(abs, relPath);
  const verb = existsSync(abs) && toolName === "write" ? "更新了文档" : toolName === "edit" ? "修改了文档" : "写入了文档";
  const docsPath = room?.docsPath;
  const outsideRoomDocsPath = !!docsPath && !relPath.startsWith(docsPath);
  const meta: KnowledgeEventMeta = { path: relPath, title, actor: agentName, tool: toolName as "write" | "edit", ...(outsideRoomDocsPath ? { outsideRoomDocsPath: true } : {}) };

  try {
    commitChatMessage(`room:${roomId}`, {
      sender: "system", content: `[Knowledge] ${agentName} ${verb}: **${title}**`, mentions: [],
      type: "knowledge_event", knowledge_event_meta: meta as unknown as Record<string, unknown>,
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

/** Connect agent event facts to transports and chat ownership; the agent core stays subscriber-free. */
import { connectChatHttpActions } from "../api/chats.js";
import { connectMemberHttpActions } from "../api/members.js";
import { connectUsageHttpQueries } from "../api/usage.js";

/** Register HTTP route modules once during application startup, never per request. */
export async function wireApiRoutes(): Promise<void> {
  await Promise.all([
    import("../api/members.js"), import("../api/chats.js"), import("../api/models.js"),
    import("../api/workspaces.js"), import("../api/files.js"), import("../api/knowledge.js"),
    import("../api/usage.js"),
  ]);
}
import { configureToolChatSender } from "../agent/tools/tools.js";
import type { MessageInput } from "../chat/messages.js";

export function wireMemberHttp(): () => void {
  return connectMemberHttpActions({
    previewPrompt: memberId => {
      const prompt = previewMemberPrompt(memberId);
      return { text: prompt.fullPrompt, contractFingerprint: prompt.contractFingerprint };
    },
    readStats,
    readTokenTotal: memberTokenTotal,
    readActivity: pageActivity,
    readStatus: memberId => ({ instances: getMemberInstances(memberId) }),
    stop: abortMember,
    compact: compactMemberById,
    reset: resetMemberSession,
    restart: restartMember,
  });
}

export function wireUsageHttp(): () => void {
  return connectUsageHttpQueries({ readUsageRows });
}

export function wireChatHttp(): () => void {
  const disconnectHttp = connectChatHttpActions({
    postMessage: commitChatMessage,
    resetSession: (_sourceRef, memberId) => resetMemberSession(memberId),
    abort: (sourceRef, memberId) => abortAgent(sourceRef, memberId),
    compact: compactMember,
    readContextUsage: (sourceRef, memberId) => getAgentContextUsage(sourceRef, memberId),
    readEvents: (sourceRef, memberId, limit, before) => loadEventsPaginated(sourceRef, memberId, limit, before),
    readTools: (sourceRef, memberId) => getMemberActiveTools(sourceRef, memberId),
    readSession: (sourceRef, memberId) => ({
      status: getAgentStatus(sourceRef, memberId),
      busy: getMemberBusyState(sourceRef, memberId),
      contextUsage: getAgentContextUsage(sourceRef, memberId),
    }),
    scopeStatus: sourceRef => getScopeLiveStatus(sourceRef),
    roomStatuses: roomId => getRoomAgentStatuses(roomId),
  });
  configureToolChatSender((sourceRef, sender, content, mentions = [], extra = {}) =>
    commitChatMessage(sourceRef, { sender, content, mentions, ...extra } as MessageInput));
  return () => { configureToolChatSender(undefined); disconnectHttp(); };
}

export function wireAgentEvents(): () => void {
  setRuntimeViewSink((scopeId, event, memberName) => {
    if (memberName === undefined) broadcastToRoom(scopeId, event);
    else broadcastToAgentSubscribers(scopeId, memberName, event);
  });
  setAgentEventSink((sourceRef, memberId, payload) => {
    const agentName = readMemberIdentity(memberId)?.name ?? memberId;
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToAgentSubscribers(target, agentName, { ...payload, roomId: target, agent: agentName });
  });
  setStatusSink((sourceRef, payload) => {
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToRoom(target, { ...payload, roomId: target });
  });
  setToolActivityHook(({ sourceRef, memberId, toolName, args, isError }) => {
    if (!sourceRef.startsWith("room:")) return;
    maybeEmitKnowledgeActivity(sourceRef.slice(5), readMemberIdentity(memberId)?.name ?? memberId, toolName, args, isError);
  });
  setContextUsageRefreshHook((sourceRef, memberId, options) => {
    if (sourceRef) refreshContextUsage(sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef, memberId, options);
  });
  return () => { setRuntimeViewSink(undefined); setAgentEventSink(undefined); setStatusSink(undefined); setToolActivityHook(undefined); setContextUsageRefreshHook(undefined); };
}
