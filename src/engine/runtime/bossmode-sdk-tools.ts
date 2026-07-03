import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChatToolDescription, CHAT_MESSAGE_PARAM_DESCRIPTION } from "../../shared/chat-tool-description.js";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  GET_TASK_DESCRIPTION,
  COMMENT_TASK_DESCRIPTION,
  QUERY_INTEGRATION_DESCRIPTION,
  CONFIGURE_INTEGRATION_DESCRIPTION,
  WRITE_SUMMARY_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../shared/mcp-tool-descriptions.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function truncate(text: string): string {
  const max = 25000;
  return text.length <= max ? text : text.slice(0, max) + `\n\n--- Result truncated (${text.length} chars). Use a more specific query. ---`;
}

export function createBossmodeSdkTools(opts: { roomId: string; agentName: string; roomMembers: string[] }): ToolDefinition[] {
  const call = async (tool: string, params: Record<string, any>) => {
    const { handleToolCallback } = await import("../tools.js");
    return handleToolCallback(tool, opts.roomId, opts.agentName, params);
  };

  return [
    defineTool({
      name: "chat",
      label: "Chat",
      description: buildChatToolDescription(opts.roomMembers.filter((m) => m !== opts.agentName).join(", ")),
      parameters: Type.Object({
        message: Type.String({ description: CHAT_MESSAGE_PARAM_DESCRIPTION }),
        target: Type.Optional(Type.String({ description: "'room' or 'user'; default follows triggering envelope footer" })),
        attachments: Type.Optional(Type.Array(Type.String(), { description: "Local file paths to attach. Files are copied to the room's attachment store." })),
        artifacts: Type.Optional(Type.Array(Type.String(), { description: "Document or file paths to show as previewable artifact chips on the room message." })),
      }),
      execute: async (_id, params) => {
        const data = await call("chat", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Chat failed");
        const targetText = (params as any).target === "user" ? "Private reply sent." : "Message sent to room.";
        return textResult(targetText + (data?.warning ? " Warning: " + data.warning : ""));
      },
    }),
    defineTool({
      name: "query_room_messages",
      label: "Query Room Messages",
      description: QUERY_ROOM_MESSAGES_DESCRIPTION,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.query })),
        from: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.from })),
        after: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.after })),
        before: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.before })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.limit })),
        output: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.output })),
      }),
      execute: async (_id, params) => {
        const data = await call("query_room_messages", params as any) as any;
        if (data && typeof data === "object" && "path" in data) return textResult("Messages written to: " + data.path + " (count: " + data.count + ")");
        const messages = Array.isArray(data) ? data : [];
        return textResult(truncate(messages.length === 0 ? "No messages found." : messages.map((m) => "[" + m.sender + "]: " + m.content).join("\n\n")));
      },
    }),
    defineTool({
      name: "read_prompt_supplement",
      label: "Read Prompt Supplement",
      description: "Read the current room or member supplemental prompt. All room members may read the room supplement; members may read their own member supplement.",
      parameters: Type.Object({
        scope: Type.String({ description: "'room' for the shared room supplement, or 'member' for your own member supplement" }),
      }),
      execute: async (_id, params) => {
        const data = await call("read_prompt_supplement", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Read prompt supplement failed");
        return textResult(truncate(JSON.stringify(data, null, 2)));
      },
    }),
    defineTool({
      name: "edit_prompt_supplement",
      label: "Edit Prompt Supplement",
      description: "Edit your own member supplement, or the room supplement if you are the configured room leader. oldText must match exactly once.",
      parameters: Type.Object({
        scope: Type.String({ description: "'room' or 'member'" }),
        oldText: Type.String({ description: "Exact text to replace. Must occur exactly once." }),
        newText: Type.String({ description: "Replacement text" }),
        note: Type.Optional(Type.String({ description: "Optional short reason for audit history" })),
      }),
      execute: async (_id, params) => {
        const data = await call("edit_prompt_supplement", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Edit prompt supplement failed");
        return textResult(`Saved ${data.scope} prompt supplement revision ${data.revision}. Applies on next member restart/reset/recreate.`);
      },
    }),
    defineTool({
      name: "write_prompt_supplement",
      label: "Write Prompt Supplement",
      description: "Overwrite your own member supplement, or the room supplement if you are the configured room leader.",
      parameters: Type.Object({
        scope: Type.String({ description: "'room' or 'member'" }),
        content: Type.String({ description: "Full markdown content to save" }),
        note: Type.Optional(Type.String({ description: "Optional short reason for audit history" })),
      }),
      execute: async (_id, params) => {
        const data = await call("write_prompt_supplement", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Write prompt supplement failed");
        return textResult(`Saved ${data.scope} prompt supplement revision ${data.revision}. Applies on next member restart/reset/recreate.`);
      },
    }),
    defineTool({
      name: "create_task",
      label: "Create Task",
      description: CREATE_TASK_DESCRIPTION,
      parameters: Type.Object({
        title: Type.String({ description: PARAM_DESCRIPTIONS.taskTitle }),
        description: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskDescription })),
        status: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskStatus })),
        priority: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskPriority })),
        assignee: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskAssignee })),
        references: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.taskReferences })),
        subscribers: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.taskSubscribers })),
      }),
      execute: async (_id, params) => {
        const data = await call("create_task", params as any) as any;
        return data?.ok ? textResult("Task created: " + data.taskId + " — " + data.title) : textResult("Failed: " + data?.error);
      },
    }),
    defineTool({
      name: "update_task",
      label: "Update Task",
      description: UPDATE_TASK_DESCRIPTION,
      parameters: Type.Object({
        taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }),
        title: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskTitle })),
        status: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskStatusUpdate })),
        priority: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskPriority })),
        assignee: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskAssignee })),
        description: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskDescription })),
        references: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.taskReferences })),
        subscribers: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.taskSubscribers })),
      }),
      execute: async (_id, params) => {
        const data = await call("update_task", params as any) as any;
        return data?.ok ? textResult("Task updated: " + data.taskId + " — status: " + data.status) : textResult("Failed: " + data?.error);
      },
    }),
    defineTool({
      name: "list_tasks",
      label: "List Tasks",
      description: LIST_TASKS_DESCRIPTION,
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskStatusFilter })),
        assignee: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskAssigneeFilter })),
      }),
      execute: async (_id, params) => {
        const tasks = await call("list_tasks", params as any) as any;
        if (!Array.isArray(tasks)) return textResult("Failed to load tasks.");
        if (tasks.length === 0) return textResult("No tasks found.");
        return textResult(tasks.map((t) => "[" + t.status + "] " + t.priority + " " + t.title + (t.assignee ? " (@" + t.assignee + ")" : "") + (t.commentCount ? " comments:" + t.commentCount : "") + " id:" + t.id).join("\n"));
      },
    }),
    defineTool({
      name: "get_task",
      label: "Get Task",
      description: GET_TASK_DESCRIPTION,
      parameters: Type.Object({ taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }) }),
      execute: async (_id, params) => {
        const data = await call("get_task", params as any) as any;
        if (data?.ok === false) return textResult("Failed: " + data.error);
        return textResult(typeof data === "string" ? truncate(data) : truncate(JSON.stringify(data, null, 2)));
      },
    }),
    defineTool({
      name: "comment_task",
      label: "Comment Task",
      description: COMMENT_TASK_DESCRIPTION,
      parameters: Type.Object({ taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }), comment: Type.String({ description: PARAM_DESCRIPTIONS.taskComment }) }),
      execute: async (_id, params) => {
        const data = await call("comment_task", params as any) as any;
        return data?.ok ? textResult("Comment added: " + data.commentId + " on " + data.taskId) : textResult("Failed: " + data?.error);
      },
    }),
    defineTool({
      name: "query_integration",
      label: "Query Integration",
      description: QUERY_INTEGRATION_DESCRIPTION,
      parameters: Type.Object({
        provider: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationProvider })),
        team: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationTeam })),
      }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("query_integration", params as any), null, 2))),
    }),
    defineTool({
      name: "configure_integration",
      label: "Configure Integration",
      description: CONFIGURE_INTEGRATION_DESCRIPTION,
      parameters: Type.Object({
        provider: Type.String({ description: PARAM_DESCRIPTIONS.integrationProvider }),
        team: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationTeam })),
        project: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationProject })),
        enabled: Type.Optional(Type.Boolean({ description: PARAM_DESCRIPTIONS.integrationEnabled })),
      }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("configure_integration", params as any), null, 2))),
    }),
    defineTool({
      name: "write_summary",
      label: "Write Summary",
      description: WRITE_SUMMARY_DESCRIPTION,
      parameters: Type.Object({
        title: Type.String({ description: PARAM_DESCRIPTIONS.summaryTitle }),
        summary: Type.String({ description: PARAM_DESCRIPTIONS.summary }),
        from_id: Type.String({ description: PARAM_DESCRIPTIONS.summaryFromId }),
        to_id: Type.String({ description: PARAM_DESCRIPTIONS.summaryToId }),
      }),
      execute: async (_id, params) => {
        const data = await call("write_summary", params as any) as any;
        return data?.ok ? textResult("Summary created: \"" + (params as any).title + "\" (" + data.coveredCount + " messages)") : textResult("Failed: " + data?.error);
      },
    }),
  ];
}
