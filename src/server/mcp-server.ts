import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  buildChatToolDescription,
  CHAT_MESSAGE_PARAM_DESCRIPTION,
  CHAT_TARGET_PARAM_DESCRIPTION,
  CHAT_MENTIONS_PARAM_DESCRIPTION,
} from "../shared/chat-tool-description.js";

/** Max chars for tool result text. ~6K tokens, aligned with Claude Code conventions. */
const MAX_RESULT_CHARS = 25_000;

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS)
    + `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

function parseJsonSafe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid tool response" };
  }
}

export function createMcpHandler(_serverUrl: string) {
  return async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    roomId: string,
    agentName: string,
    members: string[],
  ): Promise<void> {
    const callbackTool = async (tool: string, params: Record<string, unknown>): Promise<string> => {
      const internal = await import("../api/internal.js");
      const data = await internal.handleToolCallback(tool, roomId, agentName, params);
      return truncateResult(JSON.stringify(data));
    };

    const server = new McpServer({
      name: "bossmode",
      version: "1.0.0",
    });

    const otherMembers = members.filter((m) => m !== agentName);

    server.tool(
      "chat",
      buildChatToolDescription(otherMembers.join(", ")),
      {
        message: z.string().describe(CHAT_MESSAGE_PARAM_DESCRIPTION),
        target: z.string().optional().describe(CHAT_TARGET_PARAM_DESCRIPTION),
        mentions: z.array(z.string()).optional().describe(CHAT_MENTIONS_PARAM_DESCRIPTION),
      },
      async ({ message, target, mentions }) => {
        const resultText = await callbackTool("chat", { message, target, mentions });
        const result = parseJsonSafe(resultText);
        const targetText = target === "user" ? "Private reply sent." : "Message sent to room.";
        const mentionText = mentions?.length ? ` Mentioned: ${mentions.join(", ")}` : "";
        const warningText = typeof result?.warning === "string" && result.warning.length > 0
          ? ` Warning: ${result.warning}`
          : "";
        return { content: [{ type: "text", text: `${targetText}${mentionText}${warningText}` }] };
      },
    );

    server.tool(
      "query_room_messages",
      "Read recent messages from the group chat room to understand the conversation context.",
      {
        limit: z.number().optional().describe("Number of messages to retrieve (default 50)"),
      },
      async ({ limit }) => {
        const result = await callbackTool("query_room_messages", { limit });
        return { content: [{ type: "text", text: result }] };
      },
    );


    server.tool(
      "write_summary",
      "Create a topic-based summary message that covers a range of messages. Only callable by the summarizer agent.",
      {
        title: z.string().describe("Short topic title for this summary segment"),
        summary: z.string().describe("1-3 sentence summary of the key content, decisions, and conclusions"),
        from_id: z.string().describe("Message ID of the first message in this segment"),
        to_id: z.string().describe("Message ID of the last message in this segment"),
      },
      async ({ title, summary, from_id, to_id }) => {
        const result = await callbackTool("write_summary", { title, summary, from_id, to_id });
        const data = parseJsonSafe(result);
        if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
        return { content: [{ type: "text", text: `Summary created: "${title}" (${data.coveredCount} messages)` }] };
      },
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}
