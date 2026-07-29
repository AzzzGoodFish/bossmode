// Watch trigger — subscribes to message-bus, fires one-shot watch activations.
// Same shape as initRouter: activation is NOT called directly, an injected
// callback is invoked (decoupling + testability).
//
// Semantics (0.19.2 v1): only agent-authored messages trigger (senderMemberId
// present — user/system messages never do); a watch on the sender's own id is
// skipped; consume-before-activate (先销后激活) — no retry on activation failure.

import { onMessage, postMessage } from "../communication/message-bus.js";
import { logger } from "../foundation/logger.js";
import { findWatchesForTarget, consumeWatch, sweepExpired } from "../workspace/watch-store.js";
import { findRoomMemberById } from "../workspace/room-store.js";

function memberLabel(roomId: string, memberId: string): string {
  return findRoomMemberById(roomId, memberId)?.name || memberId;
}

/** Initialize watch trigger: subscribe to message-bus, invoke callback per hit watch. */
export function initWatchTrigger(
  onTrigger: (roomId: string, watcherMemberId: string, targetName: string) => void,
): () => void {
  return onMessage((roomId, message) => {
    if (!message.senderMemberId) return; // user/system messages never trigger

    // Lazy TTL: surface expirations while the room is active (system-note style,
    // same rendering as the reply-debt warning). Re-entrant-safe: system notes
    // have no senderMemberId, so they early-return in this same listener.
    for (const w of sweepExpired(roomId)) {
      postMessage(roomId, "system", `${memberLabel(roomId, w.watcherMemberId)}'s watch on ${memberLabel(roomId, w.targetMemberId)} expired.`);
    }

    const hits = findWatchesForTarget(roomId, message.senderMemberId)
      .filter((w) => w.watcherMemberId !== message.senderMemberId);
    if (hits.length === 0) return;

    const target = findRoomMemberById(roomId, message.senderMemberId);
    const targetName = target?.name || message.sender;

    for (const watch of hits) {
      // Consume FIRST (one-shot): even if activation fails, the watch is gone.
      consumeWatch(roomId, watch.id);
      const watcher = findRoomMemberById(roomId, watch.watcherMemberId);
      if (!watcher) {
        logger.info("watch", "dropWatchWatcherGone", { roomId, watchId: watch.id, watcherMemberId: watch.watcherMemberId });
        continue;
      }
      logger.info("watch", "trigger", { roomId, watchId: watch.id, watcher: watcher.name, target: targetName, msgId: message.id });
      // Room-visible note before activation (deterministic stream order).
      postMessage(roomId, "system", `${watcher.name}'s watch on ${targetName} fired (consumed).`);
      onTrigger(roomId, watch.watcherMemberId, targetName);
    }
  });
}
