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
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  WRITE_SUMMARY_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../shared/mcp-tool-descriptions.js";

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
        attachments: z.array(z.string()).optional().describe("Local file paths to attach. Files are copied to the room's attachment store. Recipients can preview/download them."),
      },
      async ({ message, target, mentions, attachments }) => {
        const resultText = await callbackTool("chat", { message, target, mentions, attachments });
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
      QUERY_ROOM_MESSAGES_DESCRIPTION,
      {
        query: z.string().optional().describe(PARAM_DESCRIPTIONS.query),
        from: z.string().optional().describe(PARAM_DESCRIPTIONS.from),
        after: z.string().optional().describe(PARAM_DESCRIPTIONS.after),
        before: z.string().optional().describe(PARAM_DESCRIPTIONS.before),
        limit: z.number().optional().describe(PARAM_DESCRIPTIONS.limit),
        output: z.enum(["text", "file"]).optional().describe(PARAM_DESCRIPTIONS.output),
      },
      async (args) => {
        const result = await callbackTool("query_room_messages", args);
        return { content: [{ type: "text", text: result }] };
      },
    );


    server.tool(
      "create_task",
      CREATE_TASK_DESCRIPTION,
      {
        title: z.string().describe(PARAM_DESCRIPTIONS.taskTitle),
        description: z.string().optional().describe(PARAM_DESCRIPTIONS.taskDescription),
        status: z.enum(["todo", "in-progress", "review", "done"]).optional().describe(PARAM_DESCRIPTIONS.taskStatus),
        priority: z.enum(["P0", "P1", "P2"]).optional().describe(PARAM_DESCRIPTIONS.taskPriority),
        assignee: z.string().optional().describe(PARAM_DESCRIPTIONS.taskAssignee),
        references: z.array(z.string()).optional().describe(PARAM_DESCRIPTIONS.taskReferences),
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
      UPDATE_TASK_DESCRIPTION,
      {
        taskId: z.string().describe(PARAM_DESCRIPTIONS.taskId),
        title: z.string().optional().describe(PARAM_DESCRIPTIONS.taskTitle),
        status: z.enum(["todo", "in-progress", "review", "done"]).optional().describe(PARAM_DESCRIPTIONS.taskStatusUpdate),
        priority: z.enum(["P0", "P1", "P2"]).optional().describe(PARAM_DESCRIPTIONS.taskPriority),
        assignee: z.string().optional().describe(PARAM_DESCRIPTIONS.taskAssignee),
        description: z.string().optional().describe(PARAM_DESCRIPTIONS.taskDescription),
        references: z.array(z.string()).optional().describe(PARAM_DESCRIPTIONS.taskReferences),
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
      LIST_TASKS_DESCRIPTION,
      {
        status: z.enum(["todo", "in-progress", "review", "done"]).optional().describe(PARAM_DESCRIPTIONS.taskStatusFilter),
        assignee: z.string().optional().describe(PARAM_DESCRIPTIONS.taskAssigneeFilter),
      },
      async (args) => {
        const result = await callbackTool("list_tasks", args);
        return { content: [{ type: "text", text: result }] };
      },
    );

    server.tool(
      "write_summary",
      WRITE_SUMMARY_DESCRIPTION,
      {
        title: z.string().describe(PARAM_DESCRIPTIONS.summaryTitle),
        summary: z.string().describe(PARAM_DESCRIPTIONS.summary),
        from_id: z.string().describe(PARAM_DESCRIPTIONS.summaryFromId),
        to_id: z.string().describe(PARAM_DESCRIPTIONS.summaryToId),
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
