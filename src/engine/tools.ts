// Agent tool callback handler — business logic for chat/messages/summary tools
import { postMessage } from "../communication/message-bus.js";
import { broadcastToRoom } from "../communication/ws.js";
import * as messageStore from "../workspace/message-store.js";
import * as roomStore from "../workspace/room-store.js";
import { parseMentions } from "../communication/router.js";
import { emitAgentReply } from "./agent-manager.js";
import { getActivationSource } from "./activation-context.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage, SummaryMeta } from "../shared/types.js";

/** Max chars for tool result text. ~6K tokens, aligned with Claude Code conventions. */
const MAX_RESULT_CHARS = 25_000;

/** Truncate a serialized tool result if it exceeds the limit. */
export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return truncated + `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

/** Handle a tool callback from an agent runtime (pi-cli extension or claude MCP) */
export async function handleToolCallback(
  tool: string,
  roomId: string,
  agentName: string,
  params: Record<string, any>,
): Promise<unknown> {
  logger.info("callback", "tool-callback", { tool, room: roomId, agent: agentName });

  switch (tool) {
    case "chat": {
      const mentions: string[] = Array.isArray(params?.mentions) ? params.mentions : [];
      let target = params?.target || "room";
      const message = params?.message || "";
      const source = getActivationSource(roomId, agentName);

      let warning: string | undefined;
      if (target === "user" && source === "room_mention") {
        target = "room";
        warning = "target: \"user\" is not allowed when activated from a room @mention. Server rewrote to \"room\". Your message was posted to the room.";
        logger.warn("callback", "target_rewrite", {
          roomId,
          agent: agentName,
          originalTarget: "user",
          rewrittenTo: "room",
          reason: "activated_from_room_mention",
          source,
        });
      }

      if (target === "user") {
        // Private reply: emit as agent_reply event, don't write to room messages
        // F11: no mention parsing/activation on private path
        emitAgentReply(roomId, agentName, message);
        logger.info("callback", "agent_reply", { roomId, agent: agentName, source: source || "unknown" });
        return warning ? { ok: true, target: "user", warning } : { ok: true, target: "user" };
      }

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      postMessage(roomId, agentName, message, mentions);

      // Soft warning: content contains @mentions not listed in mentions[]
      try {
        const room = roomStore.getRoom(roomId);
        if (!room) return warning ? { ok: true, warning } : { ok: true };

        const contentMentions = parseMentions(message, room.members).filter((m) => m !== agentName);
        const orphanMentions = contentMentions.filter((m) => !mentions.includes(m));
        if (orphanMentions.length > 0) {
          const mentionList = orphanMentions.map((m) => `@${m}`).join(", ");
          const mentionArray = orphanMentions.map((m) => `"${m}"`).join(", ");
          const orphanWarning = `Content contains ${mentionList} but mentions[] does not include them. If you meant to activate them, resend with mentions: [${mentionArray}]. If this was only a reference, no action needed.`;
          return {
            ok: true,
            warning: warning ? `${warning} ${orphanWarning}` : orphanWarning,
          };
        }
      } catch {
        // Silent degrade on warning-analysis failure
      }

      return warning ? { ok: true, warning } : { ok: true };
    }
    case "mention": {
      // Legacy — redirect to chat with mentions
      // Mention activation is handled by router listener.
      const target = params?.agent || "";
      postMessage(roomId, agentName, params?.message || "", [target]);
      return { ok: true };
    }
    case "query_room_messages": {
      const limit = params?.limit || 50;
      const messages = messageStore.getMessages(roomId, { limit });
      return messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        ts: m.ts,
      }));
    }
    case "write_summary": {
      // P0 security: only summarizer agent can call this tool
      if (agentName !== "summarizer") {
        return { ok: false, error: "write_summary can only be called by the summarizer agent" };
      }

      const { title, summary, from_id, to_id } = params;
      if (!title || !summary || !from_id || !to_id) {
        return { ok: false, error: "Missing required fields: title, summary, from_id, to_id" };
      }

      // Read range of original messages to compute metadata
      const rangeMessages = messageStore.getMessagesByRange(roomId, from_id, to_id);
      if (rangeMessages.length === 0) {
        return { ok: false, error: `No messages found in range ${from_id} to ${to_id}` };
      }

      const participants = [...new Set(rangeMessages.map((m) => m.sender))];
      const timeFrom = rangeMessages[0].ts;
      const timeTo = rangeMessages[rangeMessages.length - 1].ts;

      const summaryMeta: SummaryMeta = {
        title,
        covered_range: { from_id, to_id, count: rangeMessages.length },
        time_range: { from: timeFrom, to: timeTo },
        participants,
      };

      // Agent-friendly content format
      const dateFrom = new Date(timeFrom).toISOString().slice(0, 10);
      const dateTo = new Date(timeTo).toISOString().slice(0, 10);
      const content = `[Summary | covers ${from_id} to ${to_id} | ${dateFrom} ~ ${dateTo}]\n## ${title}\n${summary}`;

      // Write directly to message-store (bypass postMessage to avoid router @mention parsing)
      const message = messageStore.addMessage(roomId, {
        sender: "summarizer",
        content,
        mentions: [],
        type: "summary",
        summary_meta: summaryMeta,
      });

      // Broadcast via WS
      broadcastToRoom(roomId, { type: "room:message", roomId, message });
      logger.info("summarizer", "summary written", { roomId, title, from_id, to_id, count: rangeMessages.length });

      return { ok: true, title, coveredCount: rangeMessages.length };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
