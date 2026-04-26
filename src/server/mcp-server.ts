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
      "Search and retrieve messages from the current room. Without filters, returns the latest N messages (default 50). With filters, performs case-insensitive search filtered by sender and time range.",
      {
        query: z.string().optional().describe("Case-insensitive substring to search in message content"),
        from: z.string().optional().describe("Filter by sender name (exact match, e.g. 'fish' or 'developer')"),
        after: z.string().optional().describe("Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')"),
        before: z.string().optional().describe("Only messages before this time: same format as 'after'"),
        limit: z.number().optional().describe("Max messages to return (default 50, max 500)"),
        output: z.enum(["text", "file"]).optional().describe("'text' returns inline (default, may be truncated). 'file' writes to a temp markdown file and returns the path — use this for large result sets and read the file with the Read tool"),
      },
      async (args) => {
        const result = await callbackTool("query_room_messages", args);
        return { content: [{ type: "text", text: result }] };
      },
    );


    server.tool(
      "create_task",
      "Create a task in the current room. Returns the created task ID.",
      {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description (markdown)"),
        status: z.enum(["todo", "in-progress", "done"]).optional().describe("Initial status (default: todo)"),
        priority: z.enum(["P0", "P1", "P2"]).optional().describe("Priority (default: P1)"),
        assignee: z.string().optional().describe("Member name to assign the task to"),
      },
      async (args) => {
        const result = await callbackTool("create_task", args);
        const data = parseJsonSafe(result);
        if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
        return { content: [{ type: "text", text: `Task created: ${data.taskId} — ${data.title}` }] };
      },
    );

    server.tool(
      "update_task",
      "Update an existing task in the current room (status, title, priority, assignee, description).",
      {
        taskId: z.string().describe("Task ID to update"),
        title: z.string().optional().describe("New title"),
        status: z.enum(["todo", "in-progress", "done"]).optional().describe("New status"),
        priority: z.enum(["P0", "P1", "P2"]).optional().describe("New priority"),
        assignee: z.string().optional().describe("New assignee (member name), empty string to unassign"),
        description: z.string().optional().describe("New description"),
      },
      async (args) => {
        const result = await callbackTool("update_task", args);
        const data = parseJsonSafe(result);
        if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
        return { content: [{ type: "text", text: `Task updated: ${data.taskId} — status: ${data.status}` }] };
      },
    );

    server.tool(
      "list_tasks",
      "List tasks in the current room. Optionally filter by status or assignee.",
      {
        status: z.enum(["todo", "in-progress", "done"]).optional().describe("Filter by status"),
        assignee: z.string().optional().describe("Filter by assignee name"),
      },
      async (args) => {
        const result = await callbackTool("list_tasks", args);
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
