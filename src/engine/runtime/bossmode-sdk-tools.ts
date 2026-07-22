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
        attachments: Type.Optional(Type.Array(Type.String(), { description: "Local file paths to attach. Files are copied to the room's attachment store." })),
        artifacts: Type.Optional(Type.Array(Type.String(), { description: "Document or file paths to show as previewable artifact chips on the room message." })),
      }),
      execute: async (_id, params) => {
        const data = await call("chat", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Chat failed");
        return textResult("Message sent to room.");
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
        type: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.type })),
        around_seq: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.around_seq })),
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
      name: "read_memory",
      label: "Read Memory",
      description: "Read your persistent memory, with its budget header (usage/limit). asset: 'principles' (durable working rules) or 'mainline' (working focus: a '## Focus' section plus a '## Dynamic Index' list of refs — docs/..., task:<id>, msg:#<seq>; refs whose target no longer exists are marked [stale] on read, never auto-deleted). scope (optional): 'room' or 'member', principles only, default 'member'. Mainline is member-level only.",
      parameters: Type.Object({
        asset: Type.String({ description: "'principles' or 'mainline'" }),
        scope: Type.Optional(Type.String({ description: "'room' or 'member' (principles only, default 'member')" })),
      }),
      execute: async (_id, params) => {
        const data = await call("read_memory", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Read memory failed");
        const header = `${data.asset} (${data.scope}) · revision ${data.revision} · ${data.budgetHeader}`;
        const body = data.content?.trim() ? data.content : `(empty — suggested template:\n${data.suggestedTemplate || "n/a"})`;
        return textResult(truncate(`${header}\n\n${body}`));
      },
    }),
    defineTool({
      name: "edit_memory",
      label: "Edit Memory",
      description: "Edit persistent memory by exact text replacement — your own member memory, or the room principles if you are the room leader. oldText must occur exactly once. reason is required (the source of the change). Budgets: member principles 4,000 / room principles 8,000 / mainline 4,000 chars; over-budget edits are rejected with the current full text. Changes apply on next activation or Reload.",
      parameters: Type.Object({
        asset: Type.String({ description: "'principles' or 'mainline'" }),
        oldText: Type.String({ description: "Exact text to replace. Must occur exactly once." }),
        newText: Type.String({ description: "Replacement text" }),
        reason: Type.String({ description: "Required: source of this change (user feedback, a decision, curation)" }),
        scope: Type.Optional(Type.String({ description: "'room' or 'member' (principles only, default 'member')" })),
      }),
      execute: async (_id, params) => {
        const data = await call("edit_memory", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Edit memory failed");
        return textResult(`Saved ${data.scope} ${data.asset} revision ${data.revision} (${data.budgetHeader}). Applies on next member activation or Reload.`);
      },
    }),
    defineTool({
      name: "write_memory",
      label: "Write Memory",
      description: "Overwrite persistent memory wholesale — your own member memory, or the room principles if you are the room leader. reason is required (the source of the change). Budgets and over-budget rejection same as edit_memory. Changes apply on next activation or Reload.",
      parameters: Type.Object({
        asset: Type.String({ description: "'principles' or 'mainline'" }),
        content: Type.String({ description: "Full markdown content to save" }),
        reason: Type.String({ description: "Required: source of this change (user feedback, a decision, curation)" }),
        scope: Type.Optional(Type.String({ description: "'room' or 'member' (principles only, default 'member')" })),
      }),
      execute: async (_id, params) => {
        const data = await call("write_memory", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Write memory failed");
        return textResult(`Saved ${data.scope} ${data.asset} revision ${data.revision} (${data.budgetHeader}). Applies on next member activation or Reload.`);
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
  ];
}
