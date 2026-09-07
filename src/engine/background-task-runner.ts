/**
 * Background task runner — creates and runs the child session for one
 * background task, collects its final text, and settles the store record.
 *
 * Boundary (architecture/background-task-foundation-discussion-20260907.md +
 * reviews 2026-09-07 11:11 / 11:34 / 11:52):
 * - The child inherits the LIVE parent instance's start-time sources
 *   (sessionSources: member config, compiled prompts, skills, cwd, roomMembers,
 *   tool scope, runtime) and the currently applied model/credential/thinking.
 *   Nothing is re-resolved — one assembly path, no guessed defaults.
 * - Fork mode forks from the parent's CURRENT legal branch (live snapshot; the
 *   production parent file is never opened through SDK APIs), cutting BEFORE
 *   the in-flight assistant entry that issued the start call — the latest user
 *   requirement and all completed tool turns stay in. Fork failure is a real
 *   failure; there is no degrade-to-new fallback.
 * - The cancel controller is independent: only background_cancel reaches it.
 *   A cancel that lands while the child is being created skips the prompt and
 *   settles cancelled; repeated cancels are idempotent.
 * - Final = the last message_end of THIS run with stopReason "stop" and no
 *   errorMessage. Error-ending runs never return stale text as success.
 * - Terminal state is published after the run settles and destroy has been
 *   issued; destroy itself is asynchronous cleanup — we never claim it has
 *   been confirmed complete. If even the failure record cannot be written,
 *   waiters get an explicitly unsaved failure snapshot (never forever-running,
 *   never fake success).
 *
 * Codex header inheritance is FROZEN (architect 2026-09-07 11:31, fish
 * decision pending): the runner does not pass inheritCodexSessionIdFrom.
 */
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "../foundation/logger.js";
import { getRegistry, getAgentInstanceForScope } from "./agent-manager.js";
import type { BackgroundSessionSources } from "./agent-manager.js";
import {
  createBackgroundTask,
  getBackgroundTask,
  updateBackgroundTask,
  isTerminalBackgroundTaskStatus,
  failBackgroundTaskUnsaved,
} from "./background-task-store.js";
import type { AgentHandle, AgentRuntime } from "./runtime/types.js";
import type {
  BackgroundSessionMode,
  BackgroundTaskKind,
  BackgroundTaskRecord,
} from "../shared/types.js";

// -- Activation prompts ---------------------------------------------------

/**
 * recall/memorize are parameter-free: the goal is formed here. The child must
 * return its answer as final text and never post chat (the chat and wait tools
 * are execution-blocked; the shared core prompt states the exception).
 */
export function backgroundActivationPrompt(kind: BackgroundTaskKind, prompt: string): string {
  if (kind === "recall") {
    return [
      "Background recall task — you are the same member working privately in a background session; the chat and wait tools are unavailable here by design.",
      "Find what the current conversation needs from the shared memory assets: the room's project memory directory, the user memory directory, and this scope's full message history (query_room_messages works here; history reads never consume unread positions).",
      "Organize the relevant facts, decisions and open items you find, citing where each came from. If something is genuinely not recorded, say so plainly — never invent.",
      "Do not post any chat message. Return your findings as your final text; it is delivered verbatim as the task result through background_wait.",
    ].join("\n");
  }
  if (kind === "memorize") {
    return [
      "Background memorize task — you are the same member working privately in a background session; the chat and wait tools are unavailable here by design.",
      "Review the conversation you forked from and maintain the shared memory assets: record durable facts, decisions and open items in the right layer (user memory for who the user is and how they work; project memory for this room's decisions and state), keeping each file current rather than duplicating.",
      "Report exactly what you changed: each file touched and what was added or updated. Already-completed writes are never rolled back, so make each edit deliberate.",
      "Do not post any chat message. Return your change report as your final text; it is delivered verbatim as the task result through background_wait.",
    ].join("\n");
  }
  return prompt;
}

// -- Fork cut --------------------------------------------------------------

const START_TOOL_NAMES = new Set(["background_start", "recall", "memorize"]);

function entryHasStartToolCall(entry: any): boolean {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === "toolCall" && START_TOOL_NAMES.has(String(c.name ?? "")));
}

/**
 * Cut point on the parent's current branch: BEFORE the assistant entry that
 * issued this start call (found by its toolCall name). The latest user
 * requirement and every completed turn stay in the fork. When no such entry is
 * present the branch ends at the user message — the leaf is the cut.
 */
export function forkCutLeafId(branchEntries: any[]): string | null {
  const entries = branchEntries.filter((e: any) => e && typeof e.id === "string");
  if (entries.length === 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entryHasStartToolCall(entries[i])) {
      const prev = entries[i - 1];
      return prev ? prev.id : null; // nothing before the in-flight turn → empty prefix
    }
  }
  return entries[entries.length - 1].id;
}

// -- Runner ----------------------------------------------------------------

const cancelControllers = new Map<string, AbortController>(); // `${memberId}/${taskId}`

function controllerKey(memberId: string, taskId: string): string {
  return `${memberId}/${taskId}`;
}

interface ParentContext {
  sources: BackgroundSessionSources;
  /** Snapshot of the currently applied binding (follows §10 switches). */
  member: BackgroundSessionSources["member"];
  runtime: AgentRuntime;
  forkSnapshot: () => { sessionFile: string; branchEntries: unknown[] } | null;
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
  // Background tasks start from a live conversation: the child inherits the
  // parent instance's start-time sources and current applied binding.
  const instance = getAgentInstanceForScope(input.scopeId, input.memberId);
  if (!instance) {
    return { ok: false, error: "no live session for this member in this scope — background tasks start from an active conversation" };
  }
  const sources = instance.sessionSources;
  if (!sources) {
    return { ok: false, error: "parent session sources unavailable on this instance" };
  }
  const member: BackgroundSessionSources["member"] = {
    ...sources.member,
    model: instance.appliedModel || sources.member.model,
    credentialId: instance.appliedCredentialId || sources.member.credentialId,
    thinkingLevel: (instance.handle.runtimeParams?.thinkingLevel as string) || sources.member.thinkingLevel,
  };
  if (!member.model || !member.credentialId) {
    return { ok: false, error: "member has no applied model binding; configure a model before starting background tasks" };
  }
  const runtime = getRegistry()?.get(sources.runtimeName);
  if (!runtime) {
    return { ok: false, error: `runtime unavailable: ${sources.runtimeName}` };
  }
  if (input.sessionMode === "fork") {
    const snap = instance.handle.forkSnapshot?.();
    if (!snap || !snap.sessionFile) {
      return { ok: false, error: "fork unavailable: the live parent session has no snapshot" };
    }
  }
  const ctx: ParentContext = {
    sources,
    member,
    runtime,
    forkSnapshot: () => instance.handle.forkSnapshot?.() ?? null,
  };

  const record = createBackgroundTask({
    memberId: input.memberId,
    scopeId: input.scopeId,
    kind: input.kind,
    sessionMode: input.sessionMode,
    prompt: backgroundActivationPrompt(input.kind, prompt),
    snapshot: {
      model: member.model,
      credentialId: member.credentialId,
      thinkingLevel: member.thinkingLevel ?? null,
    },
    parentSessionRef: input.sessionMode === "fork" ? (instance.handle.forkSnapshot?.()?.sessionFile ?? null) : null,
  });
  // Fire-and-forget: the tool returns the real current status immediately.
  void executeBackgroundTask(record, ctx).catch((err) => {
    logger.error("background-tasks", "executor crashed", { taskId: record.taskId, error: String(err) });
    failTaskRecord(record, `executor crashed: ${String((err as Error)?.message || err)}`);
  });
  return { ok: true, taskId: record.taskId, status: record.status, startedAt: record.startedAt };
}

/** Terminal write with observable fallback: an unwritable record resolves
 *  waiters with an explicitly unsaved failure instead of hanging forever. */
function failTaskRecord(record: BackgroundTaskRecord, reason: string): void {
  try {
    updateBackgroundTask(record.memberId, record.taskId, { status: "failed", error: reason });
  } catch (err) {
    failBackgroundTaskUnsaved(record.memberId, record.taskId, `${reason}; and the failure record write threw: ${String((err as Error)?.message || err)}`);
  }
}

function settleTerminal(record: BackgroundTaskRecord, update: Parameters<typeof updateBackgroundTask>[2]): void {
  try {
    updateBackgroundTask(record.memberId, record.taskId, update);
  } catch (err) {
    failBackgroundTaskUnsaved(record.memberId, record.taskId, `terminal write failed (${String((err as Error)?.message || err)}); intended ${JSON.stringify(update.status)}`);
  }
}

/** Awaitable child teardown. Returns a diagnostic string when the confirmed
 *  cleanup failed, null when cleanup completed (or no awaitable surface
 *  existed — reported, never sold as confirmed). */
async function cleanupChild(handle: AgentHandle): Promise<string | null> {
  if (typeof handle.destroyAndWait === "function") {
    try {
      await handle.destroyAndWait();
      return null;
    } catch (err: any) {
      return `cleanup incomplete: ${err?.message || String(err)}`;
    }
  }
  try { handle.destroy(); } catch (err: any) {
    return `cleanup incomplete (non-awaitable destroy): ${err?.message || String(err)}`;
  }
  return "cleanup not confirmable: runtime exposes no awaitable teardown";
}

async function executeBackgroundTask(record: BackgroundTaskRecord, ctx: ParentContext): Promise<void> {
  const { memberId, taskId } = record;
  const controller = new AbortController();
  cancelControllers.set(controllerKey(memberId, taskId), controller);

  const settle = (update: Parameters<typeof updateBackgroundTask>[2]) => settleTerminal(record, update);

  try {
    // A cancel may have landed while the record was still "starting".
    const fresh = getBackgroundTask(memberId, taskId);
    if (!fresh || isTerminalBackgroundTaskStatus(fresh.status)) return;
    if (fresh.status !== "cancelling") {
      try {
        updateBackgroundTask(memberId, taskId, { status: "running" });
      } catch (err) {
        failBackgroundTaskUnsaved(memberId, taskId, `running-status write failed: ${String((err as Error)?.message || err)}`);
        return;
      }
    }

    // Fork prep: file-layer copy of the live branch prefix into the task dir.
    // The production parent file is never opened; the cut comes from the live
    // snapshot. Fork failure = real failure (no degrade-to-new). The forked
    // manager object is handed to the runtime directly — branch() only
    // persists on the next append, so re-opening the file would lose the cut.
    let forkManager: SessionManager | undefined;
    if (record.sessionMode === "fork") {
      const snap = ctx.forkSnapshot();
      if (!snap || !snap.sessionFile) return settle({ status: "failed", error: "fork failed: live parent snapshot disappeared before execution" });
      const cutLeafId = forkCutLeafId(snap.branchEntries as any[]);
      let forked: any;
      try {
        forked = SessionManager.forkFrom(snap.sessionFile, ctx.sources.cwd, record.sessionDir);
      } catch (err) {
        return settle({ status: "failed", error: `fork failed: ${String((err as Error)?.message || err)}` });
      }
      const forkedPath = forked?.getSessionFile?.() ?? forked?.sessionFile;
      if (!forkedPath || !existsSync(forkedPath)) {
        return settle({ status: "failed", error: "fork failed: no session file was produced" });
      }
      try {
        if (cutLeafId) forked.branch(cutLeafId);
        else if (typeof forked.resetLeaf === "function") forked.resetLeaf();
      } catch (err) {
        return settle({ status: "failed", error: `fork cut failed at ${cutLeafId}: ${String((err as Error)?.message || err)}` });
      }
      forkManager = forked as SessionManager;
    }

    let handle: AgentHandle;
    try {
      handle = await ctx.runtime.createAgent({
        cwd: ctx.sources.cwd,
        roomId: ctx.sources.toolScopeId,
        member: ctx.member,
        agentPrompt: ctx.sources.compiled.agentPrompt,
        envPrompt: ctx.sources.compiled.envPrompt,
        appendSystemPrompt: ctx.sources.compiled.appendSystemPrompt,
        skillPaths: ctx.sources.skillPaths,
        skillNames: ctx.sources.skills,
        roomMembers: ctx.sources.roomMembers,
        resumeSession: undefined,
        background: { sessionDir: record.sessionDir, sessionManager: forkManager }, // no header inheritance (frozen)
        callbacks: {
          // Final text is collected from the event stream; the child must not
          // post to any scope (chat/wait are also execution-blocked).
          onChat: async () => {},
          onMention: async () => {},
        },
      });
    } catch (err) {
      return settle({ status: "failed", error: `child session creation failed: ${String((err as Error)?.message || err)}` });
    }

    // Cancel may have landed while the child was being created: do not start
    // model work; clean up (awaited) and settle cancelled.
    if (controller.signal.aborted || getBackgroundTask(memberId, taskId)?.status === "cancelling") {
      const cleanupError = await cleanupChild(handle);
      return settle({ status: "cancelled", error: cleanupError ? `cancelled by member request; ${cleanupError}` : "cancelled by member request" });
    }

    const collected: { text: string | null } = { text: null };
    const unsubscribe = handle.subscribe((event) => {
      if (event.type !== "message_end") return;
      // Final = a genuinely successful completion of this run. Error-ended and
      // aborted turns never count; stale text is never returned as success.
      if (event.errorMessage) return;
      if (event.stopReason !== "stop") return;
      if (typeof event.text === "string" && event.text.trim().length > 0) collected.text = event.text;
    });

    const signal = controller.signal;
    const onAbort = () => {
      try { handle.abort(); } catch {}
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    let promptError: unknown = null;
    try {
      await handle.prompt(record.prompt);
    } catch (err) {
      promptError = err;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    // CONFIRMED cleanup before publishing: run has settled (prompt resolved,
    // including abort), extension session_shutdown is awaited, and the SDK's
    // synchronous dispose (resource cleanups) has run to completion. Only a
    // confirmed cleanup failure — or an SDK surface that offers no
    // confirmation — is reported, never "request issued" sold as "done".
    try { unsubscribe(); } catch {}
    const cleanupError = await cleanupChild(handle);
    if (cleanupError) {
      // Observable at error level; non-done terminals also carry it in their
      // reason so waiters see the cleanup state.
      logger.error("background-tasks", "child cleanup confirmed failed", { taskId, error: cleanupError });
    }

    const cancelled = signal.aborted || getBackgroundTask(memberId, taskId)?.status === "cancelling";
    if (cancelled) {
      return settle({ status: "cancelled", error: cleanupError ? `cancelled by member request; ${cleanupError}` : "cancelled by member request" });
    }
    if (promptError) {
      return settle({ status: "failed", error: `child run failed: ${String((promptError as Error)?.message || promptError)}${cleanupError ? `; ${cleanupError}` : ""}` });
    }
    const text = collected.text;
    if (text === null || text.trim().length === 0) {
      return settle({ status: "failed", error: `child session ended without a successful final text${cleanupError ? `; ${cleanupError}` : ""}` });
    }
    return settle({ status: "done", result: text });
  } finally {
    cancelControllers.delete(controllerKey(memberId, taskId));
  }
}

// -- Cancel ----------------------------------------------------------------

export type CancelResult =
  | { ok: true; taskId: string; status: string; note?: string }
  | { ok: false; error: string };

/** Independent cancel entry. Idempotent while cancelling; terminal records
 *  return their status untouched, without the answer. */
export function cancelBackgroundTask(memberId: string, taskId: string): CancelResult {
  const record = getBackgroundTask(memberId, taskId);
  if (!record) return { ok: false, error: `background task not found: ${taskId}` };
  if (isTerminalBackgroundTaskStatus(record.status)) {
    return { ok: true, taskId, status: record.status, note: "already finished; terminal records are immutable" };
  }
  if (record.status === "cancelling") {
    return { ok: true, taskId, status: "cancelling", note: "cancellation already requested" };
  }
  const next = updateBackgroundTask(memberId, taskId, { status: "cancelling" });
  cancelControllers.get(controllerKey(memberId, taskId))?.abort();
  return { ok: true, taskId, status: next.status };
}
