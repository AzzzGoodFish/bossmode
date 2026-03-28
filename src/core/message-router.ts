// Message Router — parses @ mentions and triggers agent activation
import { activateAgent, activateAll } from "./agent-manager.js";
import type { RoomMessage } from "../shared/types.js";
import * as roomStore from "../store/room-store.js";
import { logger } from "../foundation/logger.js";

/**
 * Process a newly sent message, activating any mentioned agents.
 * Called after the message has been stored and broadcast.
 */
export async function routeMessage(roomId: string, message: RoomMessage): Promise<void> {
  if (message.mentions.length === 0) return;

  logger.info("router", "routeMessage", { roomId, mentions: message.mentions });

  const room = roomStore.getRoom(roomId);
  if (!room) return;

  // Handle @all
  if (message.mentions.includes("all")) {
    await activateAll(roomId);
    return;
  }

  // Activate each mentioned agent
  for (const agentName of message.mentions) {
    if (!room.members.includes(agentName)) {
      // Non-member mention — skip (API already validates, but belt & suspenders)
      continue;
    }
    // Fire and forget — each activation is independent
    activateAgent(roomId, agentName).catch((err) => {
      logger.error("router", `failed to activate agent`, { agent: agentName, roomId, error: String(err) });
    });
  }
}
