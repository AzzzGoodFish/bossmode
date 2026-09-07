/**
 * Background task runner — creates and runs the child session for one
 * background task, collects its final text, and settles the store record.
 *
 * Boundary (architecture/background-task-foundation-discussion-20260907.md):
 * - The runner owns an independent cancel controller. Start/wait tool signals
 *   NEVER reach the child; only background_cancel does.
 * - The child is built through the SAME runtime.createAgent path as a live
 *   member session (same compiled prompts, skills, extensions, MCP) with the
 *   background variant: task-dir sessions, execution-level tool guards, no
 *   member session state overwrite.
 * - Fork mode cuts the parent history BEFORE the current turn (the turn that
 *   issued the start call); the in-flight tool call never enters the child.
 * - Terminal state is published only after the final result is saved and the
 *   child resources are cleaned up (destroy). Errors never fake success; a
 *   failed result write surfaces as a thrown error to the operator logs, not
 *   a silent ok.
 *
 * Codex header inheritance is FROZEN (architect 2026-09-07 11:31, fish
 * decision pending): the runner does not pass inheritCodexSessionIdFrom.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "../foundation/logger.js";
import { getBossmodeDir } from "../shared/config.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import { resolveRoomMember } from "../workforce/room-member-resolver.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { resolveGlobalSkillPaths } from "../workforce/skill-store.js";
import { activeWorkspaceRoot } from "../workspace/workspace-registry.js";
import { getEffectiveConfig } from "../workspace/member-registry.js";
import { parseScopeId } from "../shared/conversation-ref.js";
import { getTopic, resolveOwningRoomId } from "../workspace/topic-store.js";
import { compileMemberPrompt, compileMemberPromptForScope } from "./prompt-compiler.js";
import { getRegistry, memberRecordToConfig, resolveSkills } from "./agent-manager.js";
import {
  createBackgroundTask,
  getBackgroundTask,
  updateBackgroundTask,
  isTerminalBackgroundTaskStatus,
} from "./background-task-store.js";
import type {
  AgentHandle,
  AgentRuntime,
  CreateAgentOpts,
} from "./runtime/types.js";
import type {
  BackgroundSessionMode,
  BackgroundTaskKind,
  BackgroundTaskRecord,
} from "../shared/types.js";

// -- Activation prompts ---------------------------------------------------

/**
 * recall/memorize are parameter-free: the goal is formed here. Shared skill
 * flow lives in the bossmode-guide memory reference; the child must return its
 * answer as final text and never post chat (execution layer enforces the
 * posting ban; this text states the intent).
 */
export function backgroundActivationPrompt(kind: BackgroundTaskKind, prompt: string): string {
  if (kind === "recall") {
    return [
      "Background recall task. You are the same member, working privately in a background session.",
      "Search the shared memory assets (project memories, user memory, this workspace's records) for information relevant to the current conversation, and organize what you find.",
      "Do not post any chat message — the chat tool is unavailable here. Return your findings as your final text; it will be delivered verbatim as the task result.",
    ].join("\n");
  }
  if (kind === "memorize") {
    return [
      "Background memorize task. You are the same member, working privately in a background session.",
      "Review the current conversation and maintain the shared memory assets: record durable facts, decisions and open items in the right places, and report exactly what you changed (files touched, additions, updates).",
      "Do not post any chat message — the chat tool is unavailable here. Return your change report as your final text; it will be delivered verbatim as the task result.",
    ].join("\n");
  }
  return prompt;
}

// -- Context assembly (same sources as buildMemberAgentSession) -----------

interface ScopeContext {
  member: NonNullable<ReturnType<typeof memberRecordToConfig>>;
  compiled: { agentPrompt: string; envPrompt: string; appendSystemPrompt: string[] };
  skills: string[];
  skillPaths: string[];
  cwd: string;
  roomMembers: string[];
  /** The id createAgent's tools should bind to (room id, dm scope id, topic scope id). */
  toolScopeId: string;
  runtime: AgentRuntime;
}

function resolveScopeContext(memberId: string, scopeId: string): ScopeContext | null {
  const ref = parseScopeId(scopeId);
  if (!ref) return null;
  const registry = getRegistry();
  if (!registry) return null;
  const docsRootPath = join(getBossmodeDir(), "memory", "projects");

  if (ref.kind === "dm") {
    const member = memberRecordToConfig(memberId);
    if (!member) return null;
    const agentDef = loadAgentDefinition(member.agent) || {
      name: member.agent, description: member.agent, systemPrompt: `You are ${member.name}.`, tags: [], skills: [],
    };
    const runtime = registry.get(member.runtime);
    if (!runtime) return null;
    const compiled = compileMemberPromptForScope({
      scopeId,
      memberId,
      memberName: member.name,
      agentDef,
      room: null,
      docsRoot: docsRootPath,
    });
    return {
      member,
      compiled,
      skills: resolveSkills(member, agentDef),
      skillPaths: [],
      cwd: activeWorkspaceRoot(memberId),
      roomMembers: [member.name],
      toolScopeId: scopeId,
      runtime,
    };
  }

  if (ref.kind === "room") {
    const room = roomStore.getRoom(ref.roomId);
    if (!room) return null;
    let m = resolveRoomMember(ref.roomId, memberId);
    if (!m) return null;
    try {
      const globalId = roomStore.resolveGlobalMemberId(room, m);
      if (globalId) {
        const eff = getEffectiveConfig(globalId, `room:${ref.roomId}`);
        m = {
          ...m,
          model: eff.model || m.model,
          credentialId: eff.credentialId || m.credentialId,
          thinkingLevel: (eff.thinkingLevel as string) || m.thinkingLevel,
          skills: eff.skills?.length ? eff.skills : m.skills,
          mcpServers: eff.mcpServers?.length ? eff.mcpServers : m.mcpServers,
        };
      }
    } catch (err) {
      logger.warn("background-tasks", "effective-config overlay skipped", { memberId, error: String(err) });
    }
    const agentDef = loadAgentDefinition(m.agent);
    if (!agentDef) return null;
    const runtime = registry.get(m.runtime);
    if (!runtime) return null;
    const compiled = compileMemberPrompt({ room, member: m, agentDef, docsRoot: docsRootPath });
    const skills = resolveSkills(m, agentDef);
    return {
      member: m,
      compiled,
      skills,
      skillPaths: [...resolveGlobalSkillPaths(skills)],
      cwd: activeWorkspaceRoot(memberId),
      roomMembers: room.members,
      toolScopeId: `room:${ref.roomId}`,
      runtime,
    };
  }

  // topic: parent-room roster + topic-titled Environment (byte-identical rule)
  const topicId = ref.topicId;
  const parentRoomId = resolveOwningRoomId(scopeId);
  const room = parentRoomId ? roomStore.getRoom(parentRoomId) : null;
  if (!room) return null;
  let m = resolveRoomMember(parentRoomId, memberId) || memberRecordToConfig(memberId);
  if (!m) return null;
  const agentDef = loadAgentDefinition(m.agent) || {
    name: m.agent, description: m.agent, systemPrompt: `You are ${m.name}.`, tags: [], skills: [],
  };
  const runtime = registry.get(m.runtime);
  if (!runtime) return null;
  const topicRec = getTopic(parentRoomId, topicId);
  const compiled = compileMemberPromptForScope({
    scopeId,
    memberId,
    memberName: m.name,
    agentDef,
    room,
    docsRoot: docsRootPath,
    topicTitle: topicRec?.title ?? null,
  });
  const skills = resolveSkills(m, agentDef);
  return {
    member: m,
    compiled,
    skills,
    skillPaths: [...resolveGlobalSkillPaths(skills)],
    cwd: activeWorkspaceRoot(memberId),
    roomMembers: room.members,
    toolScopeId: scopeId,
    runtime,
  };
}

// -- Parent session lookup (fork source) ----------------------------------

function parentSessionFileFor(memberId: string, scopeId: string): string | null {
  const ref = parseScopeId(scopeId);
  if (!ref) return null;
  if (ref.kind === "room") {
    return sessionStore.getSessions(ref.roomId)[memberId]?.sessionFile ?? null;
  }
  if (ref.kind === "topic") {
    const parentRoomId = resolveOwningRoomId(scopeId);
    if (!parentRoomId) return null;
    // topic sessions live in the topic fork store
    try {
      const sessionsJson = join(roomStore.roomDir(parentRoomId), "topics", ref.topicId, "sessions.json");
      if (!existsSync(sessionsJson)) return null;
      const all = JSON.parse(readFileSync(sessionsJson, "utf-8"));
      return all[memberId]?.sessionFile ?? null;
    } catch {
      return null;
    }
  }
  return null; // dm scopes have no persisted member session
}

/**
 * Fork cut point: the entry BEFORE the last user message (the turn that issued
 * the background start). The in-flight tool call never enters the child.
 */
function forkCutLeafId(entries: any[]): string | null {
  const users = entries.filter((e: any) => e?.type === "message" && e.message?.role === "user" && e.id);
  if (users.length === 0) return null;
  const lastUser = users[users.length - 1];
  const idx = entries.indexOf(lastUser);
  const before = entries[idx - 1];
  return before?.id ?? null;
}

// -- Runner ----------------------------------------------------------------

const cancelControllers = new Map<string, AbortController>(); // `${memberId}/${taskId}`

function controllerKey(memberId: string, taskId: string): string {
  return `${memberId}/${taskId}`;
}

export interface StartBackgroundTaskInput {
  memberId: string;
  scopeId: string;
  kind: BackgroundTaskKind;
  sessionMode: BackgroundSessionMode;
  prompt: string;
}

export type StartBackgroundTaskResult =
  | { ok: true; taskId: string; status: string; startedAt: string }
  | { ok: false; error: string };

export function startBackgroundTask(input: StartBackgroundTaskInput): StartBackgroundTaskResult {
  if (input.sessionMode !== "new" && input.sessionMode !== "fork") {
    return { ok: false, error: "sessionMode must be 'new' or 'fork'" };
  }
  const prompt = String(input.prompt ?? "").trim();
  if (input.kind === "generic" && !prompt) {
    return { ok: false, error: "prompt is required" };
  }
  const ctx = resolveScopeContext(input.memberId, input.scopeId);
  if (!ctx || !ctx.member) {
    return { ok: false, error: `member or scope not resolvable: ${input.memberId} in ${input.scopeId}` };
  }
  if (!ctx.member.model || !ctx.member.credentialId) {
    return { ok: false, error: `member has no model binding; configure a model before starting background tasks` };
  }
  const parentSessionFile = input.sessionMode === "fork" ? parentSessionFileFor(input.memberId, input.scopeId) : null;
  const record = createBackgroundTask({
    memberId: input.memberId,
    scopeId: input.scopeId,
    kind: input.kind,
    sessionMode: input.sessionMode,
    prompt: backgroundActivationPrompt(input.kind, prompt),
    snapshot: {
      model: ctx.member.model,
      credentialId: ctx.member.credentialId,
      thinkingLevel: ctx.member.thinkingLevel ?? null,
    },
    parentSessionRef: parentSessionFile,
  });
  // Fire-and-forget: the tool returns the real current status immediately.
  void executeBackgroundTask(record, ctx).catch((err) => {
    logger.error("background-tasks", "executor crashed", { taskId: record.taskId, error: String(err) });
  });
  return { ok: true, taskId: record.taskId, status: record.status, startedAt: record.startedAt };
}

async function executeBackgroundTask(record: BackgroundTaskRecord, ctx: ScopeContext): Promise<void> {
  const { memberId, taskId } = record;
  // Cancel may have landed while the record was still "starting".
  const fresh = getBackgroundTask(memberId, taskId);
  if (!fresh || isTerminalBackgroundTaskStatus(fresh.status)) return;
  if (fresh.status !== "cancelling") {
    try {
      updateBackgroundTask(memberId, taskId, { status: "running" });
    } catch (err) {
      logger.error("background-tasks", "failed to mark running", { taskId, error: String(err) });
      return;
    }
  }

  let handle: AgentHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  const collected: { text: string | null } = { text: null };
  const controller = new AbortController();
  cancelControllers.set(controllerKey(memberId, taskId), controller);

  try {
    // Fork prep: file-layer copy of the parent prefix into the task dir.
    let resumeSession: CreateAgentOpts["resumeSession"];
    if (record.sessionMode === "fork" && record.parentSessionRef && existsSync(record.parentSessionRef)) {
      try {
        const source = SessionManager.open(record.parentSessionRef, dirname(record.parentSessionRef), ctx.cwd);
        const entries = typeof source.getEntries === "function" ? source.getEntries() : [];
        const cutLeafId = forkCutLeafId(entries);
        const forked = SessionManager.forkFrom(record.parentSessionRef, ctx.cwd, record.sessionDir);
        const forkedPath = forked.getSessionFile?.() || (forked as any).sessionFile;
        if (forkedPath && existsSync(forkedPath)) {
          if (cutLeafId && typeof forked.branch === "function") {
            try { forked.branch(cutLeafId); } catch (branchErr) {
              logger.warn("background-tasks", "fork branch(cutLeaf) failed; keeping full copy", { taskId, cutLeafId, error: String(branchErr) });
            }
          }
          resumeSession = { sessionFile: forkedPath };
        }
      } catch (err) {
        logger.warn("background-tasks", "fork failed; running as new session", { taskId, error: String(err) });
      }
    }

    handle = await ctx.runtime.createAgent({
      cwd: ctx.cwd,
      roomId: ctx.toolScopeId,
      member: ctx.member,
      agentPrompt: ctx.compiled.agentPrompt,
      envPrompt: ctx.compiled.envPrompt,
      appendSystemPrompt: ctx.compiled.appendSystemPrompt,
      skillPaths: ctx.skillPaths,
      skillNames: ctx.skills,
      roomMembers: ctx.roomMembers,
      resumeSession,
      background: { sessionDir: record.sessionDir }, // no header inheritance (frozen)
      callbacks: {
        // Final text is collected from the event stream below; the child must
        // not post to any scope. The chat tool is execution-blocked as well.
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    unsubscribe = handle.subscribe((event) => {
      if (event.type === "message_end" && typeof event.text === "string" && event.text.trim().length > 0) {
        collected.text = event.text;
      }
    });

    // Independent cancel controller: background_cancel aborts the child;
    // start/wait tool signals never reach here.
    const signal = controller.signal;
    const onAbort = () => {
      try { handle?.abort(); } catch {}
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    await handle.prompt(record.prompt);
    signal.removeEventListener("abort", onAbort);
    const wasCancelled = signal.aborted || (getBackgroundTask(memberId, taskId)?.status === "cancelling");

    // Cleanup BEFORE publishing the terminal record (review: publish after
    // result saved and resources cleaned — store write notifies waiters).
    unsubscribe?.();
    unsubscribe = null;
    try { handle.destroy(); } catch (err) {
      logger.warn("background-tasks", "child destroy failed", { taskId, error: String(err) });
    }
    handle = null;

    if (wasCancelled) {
      updateBackgroundTask(memberId, taskId, { status: "cancelled", error: "cancelled by member request" });
      return;
    }
    const text: string | null = collected.text;
    if (text === null || text.trim().length === 0) {
      updateBackgroundTask(memberId, taskId, { status: "failed", error: "child session ended without final text" });
      return;
    }
    updateBackgroundTask(memberId, taskId, { status: "done", result: text });
  } catch (err) {
    // Path: creation failure or prompt throw. Clean up, then record failure —
    // never fake success. If a cancel raced the failure, cancel wins.
    try { unsubscribe?.(); } catch {}
    if (handle) {
      try { handle.destroy(); } catch {}
    }
    const now = getBackgroundTask(memberId, taskId);
    if (now && !isTerminalBackgroundTaskStatus(now.status)) {
      const status = now.status === "cancelling" ? "cancelled" : "failed";
      updateBackgroundTask(memberId, taskId, status === "cancelled"
        ? { status: "cancelled", error: "cancelled by member request" }
        : { status: "failed", error: String((err as Error)?.message || err) });
    }
  } finally {
    cancelControllers.delete(controllerKey(memberId, taskId));
  }
}

// -- Cancel ----------------------------------------------------------------

export type CancelResult =
  | { ok: true; taskId: string; status: string; note?: string }
  | { ok: false; error: string };

/** Independent cancel entry. Terminal records are returned untouched, no answer. */
export function cancelBackgroundTask(memberId: string, taskId: string): CancelResult {
  const record = getBackgroundTask(memberId, taskId);
  if (!record) return { ok: false, error: `background task not found: ${taskId}` };
  if (isTerminalBackgroundTaskStatus(record.status)) {
    return { ok: true, taskId, status: record.status, note: "already finished; terminal records are immutable" };
  }
  const next = updateBackgroundTask(memberId, taskId, { status: "cancelling" });
  cancelControllers.get(controllerKey(memberId, taskId))?.abort();
  return { ok: true, taskId, status: next.status };
}
