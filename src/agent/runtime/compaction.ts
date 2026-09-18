/** SDK compaction watchdog: thresholds, continuation prompts, and session shutdown.
 * The handle keeps run/turn state; this module owns the decision math and teardown. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { logger } from "../../kernel/logger.js";

export interface CompactionWatchdogRun {
  maxTokens: number;
  threshold: number;
  /** Mid-run action line: threshold − WATCHDOG_SAFETY_MARGIN. */
  actionThreshold: number;
  contextWindow: number;
  model: string;
  compactionEventSeen: boolean;
  /** Watchdog aborted this run for compaction (mid-run crossing with pending tool calls). */
  interventionRequested: boolean;
  /** Assistant stop with empty text and ≤1 output token (max_tokens clamp fault or transient). */
  emptyStopSeen: boolean;
}

export interface WatchdogTurnState {
  interventions: number;
  emptyRetries: number;
}


/**
 * Buffer below the SDK compaction threshold for mid-run action. The SDK only
 * checks compaction at run boundaries; a single tool result can add tens of
 * thousands of tokens mid-run, so the watchdog acts earlier (2026-07-29 k3
 * empty-response loop: max_tokens clamped to 1 → empty reply → poisoned usage
 * blinded the boundary check).
 */
export const WATCHDOG_SAFETY_MARGIN = 32768;


/**
 * Action line = threshold − SAFETY_MARGIN, floored at 50% of the window: the
 * bare formula degenerates for small windows (reserveTokens + margin ≈ the
 * whole window), which would compact nearly every turn. The floor only affects
 * windows ≲114k; k3-class windows are unchanged (450848 for a 500k window).
 */
export function watchdogActionThreshold(contextWindow: number, reserveTokens: number): number {
  return Math.max(contextWindow - reserveTokens - WATCHDOG_SAFETY_MARGIN, Math.floor(contextWindow / 2));
}


/** Continue instruction after a watchdog compaction (full prompt path, so the
 * SDK's post-run handling — boundary compaction check, queue drain — stays intact). */
export const WATCHDOG_CONTINUE_PROMPT =
  "⚠ Context was automatically compacted to stay within the model's context window. Continue your work from where you stopped.";


/** One verbatim retry nudge for an empty response at LOW usage (transient
 * provider behavior — compaction is never triggered by response shape). */
export const WATCHDOG_EMPTY_RETRY_PROMPT =
  "⚠ Your previous response came back empty (no content). Repeat your previous response.";

export function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text || "")
    .join("");
}

export function assistantHasToolCalls(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((c: any) => c?.type === "toolCall");
}


/** Complete every supported shutdown stage, even after an earlier failure. */
export async function shutdownSdkSession(session: AgentSession, beforeDispose?: () => void, settleResources?: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  // The SDK's AgentSession.abort() awaits waitForIdle itself — awaiting ITS
  // promise here is the awaitable run-end, unlike the void handle.abort().
  try {
    await session.abort();
  } catch (err: any) {
    errors.push(`abort: ${err?.message || String(err)}`);
  }
  try {
    session.abortCompaction();
    session.abortBranchSummary();
  } catch {}
  try { await settleResources?.(); } catch (error) { errors.push(`resource settlement: ${String(error)}`); }
  const runner: any = session.extensionRunner;
  if (typeof runner?.hasHandlers === "function" && runner.hasHandlers("session_shutdown")) {
    // Handler failures surface via onError ({extensionPath, event, error}),
    // never as emit() rejections — collect them for THIS shutdown only.
    const shutdownErrors: string[] = [];
    const off = typeof runner.onError === "function"
      ? runner.onError((e: any) => {
          if (e?.event === "session_shutdown") shutdownErrors.push(`${e?.extensionPath ?? "extension"}: ${e?.error ?? "unknown error"}`);
        })
      : null;
    try {
      await runner.emit({ type: "session_shutdown" } as any);
    } catch (err: any) {
      errors.push(`session_shutdown emit: ${err?.message || String(err)}`);
    } finally {
      try { off?.(); } catch {}
    }
    errors.push(...shutdownErrors);
  }
  try { beforeDispose?.(); } catch {}
  // Always runs, even when earlier stages failed. dispose() is synchronous
  // and throws AggregateError when a registered resource cleanup fails.
  try {
    session.dispose();
  } catch (err: any) {
    const detail = err instanceof AggregateError && Array.isArray(err.errors)
      ? err.errors.map((e: any) => e?.message || String(e)).join(", ")
      : err?.message || String(err);
    errors.push(`dispose: ${detail}`);
  }
  return errors;
}
