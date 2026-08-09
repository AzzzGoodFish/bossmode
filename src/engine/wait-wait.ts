// Blocking wait — leader tool that holds the current turn until a target event.
// Replaces the old one-shot watch subscription (watches.json + activateAgentForWatch).
//
// Resolves when ANY of:
//   1. target posts an agent-authored room message
//   2. target transitions to idle (or is already idle at call time)
//   3. target transitions to idle after a turn error → reason "error"
//   4. waiter is @-mentioned → settle mention_interrupt (no abort; message arrives via steer)
//   5. timeout (default 30 min, max 360)
//   6. user Stop → abortAgent settles wait first, then aborts the turn
//
// One wait per waiter at a time. Cursor is NOT advanced — normal activation owns that.
//
// @-while-waiting (fish 0.19.6): standard activation steers the message first (cursor
// advances once); wait settles mention_interrupt one tick later so the next model
// request sees tool-result then steered user message. Wait never carries message body.
//
// Error idle (fish 2026-08-09): target turn failure (e.g. request terminated) still
// flips status to idle — waiter must learn it was an error exit with no output, not a
// normal completion. Transient provider retries keep status working and do not wake wait.

import { onMessage } from "../communication/message-bus.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";

export type WaitReason = "message" | "idle" | "error" | "mention_interrupt" | "timeout";

export interface WaitResult {
  ok: true;
  reason: WaitReason;
  target: string;
  /** Target message body when reason === "message". */
  message?: string;
  detail: string;
}

export interface WaitError {
  ok: false;
  error: string;
}

export type WaitOutcome = WaitResult | WaitError;

const DEFAULT_TIMEOUT_MIN = 30;
const MAX_TIMEOUT_MIN = 360;

interface ActiveWait {
  roomId: string;
  waiterMemberId: string;
  waiterName: string;
  targetMemberId: string;
  targetName: string;
  resolve: (outcome: WaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  unsubMessage: () => void;
  settled: boolean;
}

/** roomId:waiterMemberId → active wait */
const activeWaits = new Map<string, ActiveWait>();

/** Idle listeners: roomId:targetMemberId → Set of callbacks (error text when turn failed). */
const idleListeners = new Map<string, Set<(info?: { error?: string }) => void>>();

function waitKey(roomId: string, waiterMemberId: string): string {
  return `${roomId}:${waiterMemberId}`;
}

function idleKey(roomId: string, targetMemberId: string): string {
  return `${roomId}:${targetMemberId}`;
}

function settle(wait: ActiveWait, outcome: WaitOutcome): void {
  if (wait.settled) return;
  wait.settled = true;
  clearTimeout(wait.timer);
  try { wait.unsubMessage(); } catch { /* ignore */ }
  detachIdleListener(wait);
  activeWaits.delete(waitKey(wait.roomId, wait.waiterMemberId));
  logger.info("wait", "settled", {
    roomId: wait.roomId,
    waiter: wait.waiterName,
    target: wait.targetName,
    ok: outcome.ok,
    reason: outcome.ok ? outcome.reason : undefined,
    error: outcome.ok ? undefined : outcome.error,
  });
  wait.resolve(outcome);
}

/** Called from abortAgent (Stop) — settle wait before the turn is aborted. */
export function settleWaitOnAbort(roomId: string, memberId: string): void {
  const wait = activeWaits.get(waitKey(roomId, memberId));
  if (!wait) return;
  settle(wait, {
    ok: true,
    reason: "mention_interrupt",
    target: wait.targetName,
    detail: `Wait interrupted — stopped. Target was ${wait.targetName}.`,
  });
}

function detachIdleListener(wait: ActiveWait): void {
  const ik = idleKey(wait.roomId, wait.targetMemberId);
  const set = idleListeners.get(ik);
  if (!set) return;
  // Find and remove the callback that belongs to this wait (stored on wait via symbol)
  const cb = (wait as any)._idleCb as ((info?: { error?: string }) => void) | undefined;
  if (cb) set.delete(cb);
  if (set.size === 0) idleListeners.delete(ik);
}

/**
 * Notify waiters that a member became idle.
 * Wired from agent-manager.transition() when newStatus === "idle".
 * Pass `error` when the just-finished turn failed so wait settles with reason "error".
 */
export function notifyMemberIdle(roomId: string, memberId: string, info?: { error?: string }): void {
  const set = idleListeners.get(idleKey(roomId, memberId));
  if (!set || set.size === 0) return;
  for (const cb of [...set]) {
    try { cb(info); } catch (err) {
      logger.error("wait", "idle listener error", { error: String(err) });
    }
  }
}

/** True if this member currently has a blocking wait in flight. */
export function isMemberWaiting(roomId: string, memberId: string): boolean {
  return activeWaits.has(waitKey(roomId, memberId));
}

/**
 * Block until target speaks, becomes idle, waiter is @-mentioned/stopped, or timeout.
 * Caller is responsible for leader gate and member resolution.
 */
export function waitForMember(args: {
  roomId: string;
  waiterMemberId: string;
  waiterName: string;
  targetMemberId: string;
  targetName: string;
  /** Current status of the target ("idle" | "working" | "inactive"). */
  targetStatus: string;
  timeoutMinutes?: number;
}): Promise<WaitOutcome> {
  const {
    roomId,
    waiterMemberId,
    waiterName,
    targetMemberId,
    targetName,
    targetStatus,
  } = args;

  if (waiterMemberId === targetMemberId) {
    return Promise.resolve({ ok: false, error: "Cannot wait on yourself" });
  }

  const key = waitKey(roomId, waiterMemberId);
  if (activeWaits.has(key)) {
    return Promise.resolve({ ok: false, error: "You already have a wait in progress; only one wait at a time" });
  }

  // Target already idle → immediate return (nothing to wait for).
  if (targetStatus === "idle") {
    return Promise.resolve({
      ok: true,
      reason: "idle",
      target: targetName,
      detail: `${targetName} is already idle — speak to them directly.`,
    });
  }

  let timeoutMin = typeof args.timeoutMinutes === "number" && Number.isFinite(args.timeoutMinutes)
    ? Math.floor(args.timeoutMinutes)
    : DEFAULT_TIMEOUT_MIN;
  if (timeoutMin < 1) timeoutMin = 1;
  if (timeoutMin > MAX_TIMEOUT_MIN) timeoutMin = MAX_TIMEOUT_MIN;

  return new Promise<WaitOutcome>((resolve) => {
    const wait = {
      roomId,
      waiterMemberId,
      waiterName,
      targetMemberId,
      targetName,
      resolve,
      settled: false,
    } as ActiveWait;

    const finish = (outcome: WaitOutcome) => settle(wait, outcome);

    // 1) Target message OR waiter @-mention
    wait.unsubMessage = onMessage((msgRoomId: string, message: RoomMessage) => {
      if (msgRoomId !== roomId) return;

      // Waiter was @-mentioned (by anyone including user).
      // Do NOT abort — standard activation steers the message while working;
      // settle wait one tick later so steer is queued first (tool-result then user msg).
      const mentioned =
        (message.mentionMemberIds && message.mentionMemberIds.includes(waiterMemberId)) ||
        (Array.isArray(message.mentions) && message.mentions.includes(waiterName));
      if (mentioned && message.senderMemberId !== waiterMemberId) {
        const sender = message.sender || "someone";
        setTimeout(() => {
          finish({
            ok: true,
            reason: "mention_interrupt",
            target: targetName,
            detail: `Wait interrupted — you were mentioned by ${sender}. The mention was delivered via the normal activation path; continue from that message.`,
          });
        }, 0);
        return;
      }

      // Target agent-authored message.
      if (!message.senderMemberId) return;
      if (message.senderMemberId !== targetMemberId) return;
      finish({
        ok: true,
        reason: "message",
        target: targetName,
        message: message.content,
        detail: `${targetName} posted a message.`,
      });
    });

    // 2) Target becomes idle (normal or after turn error)
    const onIdle = (info?: { error?: string }) => {
      const errText = typeof info?.error === "string" ? info.error.trim() : "";
      if (errText) {
        finish({
          ok: true,
          reason: "error",
          target: targetName,
          detail: `${targetName}'s last turn ended with an error (${errText}). No output produced — verify status before continuing.`,
        });
        return;
      }
      finish({
        ok: true,
        reason: "idle",
        target: targetName,
        detail: `${targetName} became idle.`,
      });
    };
    (wait as any)._idleCb = onIdle;
    const ik = idleKey(roomId, targetMemberId);
    let set = idleListeners.get(ik);
    if (!set) {
      set = new Set();
      idleListeners.set(ik, set);
    }
    set.add(onIdle);

    // 3) Timeout
    wait.timer = setTimeout(() => {
      finish({
        ok: true,
        reason: "timeout",
        target: targetName,
        detail: `Timed out after ${timeoutMin} minute${timeoutMin === 1 ? "" : "s"} waiting on ${targetName}. No event occurred.`,
      });
    }, timeoutMin * 60_000);
    if (typeof wait.timer === "object" && wait.timer && "unref" in wait.timer) {
      try { (wait.timer as NodeJS.Timeout).unref(); } catch { /* ignore */ }
    }

    activeWaits.set(key, wait);
    logger.info("wait", "started", {
      roomId,
      waiter: waiterName,
      target: targetName,
      timeoutMin,
      targetStatus,
    });
  });
}

/** Test helper — drop all waits (no resolve). */
export function clearAllWaitsForTests(): void {
  for (const wait of activeWaits.values()) {
    wait.settled = true;
    clearTimeout(wait.timer);
    try { wait.unsubMessage(); } catch { /* ignore */ }
    detachIdleListener(wait);
  }
  activeWaits.clear();
  idleListeners.clear();
}

export const WAIT_DEFAULT_TIMEOUT_MIN = DEFAULT_TIMEOUT_MIN;
export const WAIT_MAX_TIMEOUT_MIN = MAX_TIMEOUT_MIN;
