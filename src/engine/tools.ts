// Agent tool callback handler — business logic for chat/knowledge/messages tools
import { postMessage } from "../communication/message-bus.js";
import * as messageStore from "../workspace/message-store.js";
import * as roomStore from "../workspace/room-store.js";
import * as knowledgeStore from "../knowledge/store.js";
import { emitAgentReply, activateAgent } from "./agent-manager.js";
import { logger } from "../foundation/logger.js";

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
      const target = params?.target || "room";

      if (target === "user") {
        // Private reply: emit as agent_reply event, don't write to room messages
        emitAgentReply(roomId, agentName, params?.message || "");
        logger.info("callback", "agent_reply", { roomId, agent: agentName });
        return { ok: true, target: "user" };
      } else {
        // Room message via message-bus (writes + broadcasts + notifies listeners)
        postMessage(roomId, agentName, params?.message || "", mentions);
        // Activate mentioned agents
        for (const t of mentions) {
          activateAgent(roomId, t).catch((err) => {
            logger.error("callback", "mention activate failed", { target: t, error: String(err) });
          });
        }
        return { ok: true };
      }
    }
    case "mention": {
      // Legacy — redirect to chat with mentions
      const target = params?.agent || "";
      postMessage(roomId, agentName, params?.message || "", [target]);
      activateAgent(roomId, target).catch((err) => {
        logger.error("callback", "mention activate failed", { target, error: String(err) });
      });
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
    case "save_knowledge": {
      const room = roomStore.getRoom(roomId);
      if (room?.knowledgeBaseId) {
        knowledgeStore.addEntry(room.knowledgeBaseId, params?.title || "", params?.content || "", agentName);
      }
      return { ok: true };
    }
    case "update_knowledge": {
      const room = roomStore.getRoom(roomId);
      if (!room?.knowledgeBaseId) return { ok: false, error: "No knowledge base linked to this room" };
      const entryId = params?.entryId;
      if (!entryId) return { ok: false, error: "entryId is required" };
      const updated = knowledgeStore.updateEntry(room.knowledgeBaseId, entryId, params?.title || "", params?.content || "");
      if (!updated) return { ok: false, error: `Entry not found: ${entryId}` };
      return { ok: true, entry: { id: updated.id, title: updated.title } };
    }
    case "delete_knowledge": {
      const room = roomStore.getRoom(roomId);
      if (!room?.knowledgeBaseId) return { ok: false, error: "No knowledge base linked to this room" };
      const entryId = params?.entryId;
      if (!entryId) return { ok: false, error: "entryId is required" };
      const deleted = knowledgeStore.deleteEntry(room.knowledgeBaseId, entryId);
      if (!deleted) return { ok: false, error: `Entry not found: ${entryId}` };
      return { ok: true };
    }
    case "query_knowledge": {
      const room = roomStore.getRoom(roomId);
      if (room?.knowledgeBaseId) {
        let entries = knowledgeStore.listEntries(room.knowledgeBaseId);
        if (params?.query) {
          // Filtered query — return full content of matching entries
          const q = params.query.toLowerCase();
          entries = entries.filter((e) => e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
          return entries;
        }
        // No query — return summaries only (title + type + id) to avoid huge payloads
        return entries.map((e) => ({
          id: e.id,
          title: e.title,
          type: e.type,
          source: e.source,
          contentPreview: e.content.slice(0, 200) + (e.content.length > 200 ? "..." : ""),
        }));
      }
      return [];
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
