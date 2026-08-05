import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChatToolDescription, CHAT_MESSAGE_PARAM_DESCRIPTION } from "../../shared/chat-tool-description.js";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  LIST_SCOPES_DESCRIPTION,
  GET_TASK_DESCRIPTION,
  COMMENT_TASK_DESCRIPTION,
  QUERY_INTEGRATION_DESCRIPTION,
  CONFIGURE_INTEGRATION_DESCRIPTION,
  WAIT_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../shared/mcp-tool-descriptions.js";
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function truncate(text: string): string {
  const max = 25000;
  return text.length <= max ? text : text.slice(0, max) + `\n\n--- Result truncated (${text.length} chars). Use a more specific query. ---`;
}

export function createBossmodeSdkTools(opts: {
  roomId: string;
  agentName: string;
  roomMembers: string[];
  /** 0.20 scope kind — dm gets create_room/list_members; room gets wait/tasks. Default room. */
  scopeKind?: "dm" | "room";
}): ToolDefinition[] {
  const scopeKind = opts.scopeKind || "room";
  const call = async (tool: string, params: Record<string, any>) => {
    const { handleToolCallback } = await import("../tools.js");
    return handleToolCallback(tool, opts.roomId, opts.agentName, params);
  };

  const tools: ToolDefinition[] = [
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
        scope: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.scope })),
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
        target_scope: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.targetScope })),
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
      description: "Edit persistent memory by exact text replacement — your own member memory, or the room principles if you are the room leader. oldText must occur exactly once. reason is required (the source of the change). Budgets: member principles 4,000 / room principles 8,000 / mainline 4,000 chars; over-budget edits are rejected with the current full text. Changes apply on Reload or a fresh session (a running session keeps its already-compiled prompt).",
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
        return textResult(`Saved ${data.scope} ${data.asset} revision ${data.revision} (${data.budgetHeader}). ${data.message ?? "Applies on Reload or a fresh session."}`);
      },
    }),
    defineTool({
      name: "write_memory",
      label: "Write Memory",
      description: "Overwrite persistent memory wholesale — your own member memory, or the room principles if you are the room leader. reason is required (the source of the change). Budgets and over-budget rejection same as edit_memory. Changes apply on Reload or a fresh session (a running session keeps its already-compiled prompt).",
      parameters: Type.Object({
        asset: Type.String({ description: "'principles' or 'mainline'" }),
        content: Type.String({ description: "Full markdown content to save" }),
        reason: Type.String({ description: "Required: source of this change (user feedback, a decision, curation)" }),
        scope: Type.Optional(Type.String({ description: "'room' or 'member' (principles only, default 'member')" })),
      }),
      execute: async (_id, params) => {
        const data = await call("write_memory", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Write memory failed");
        return textResult(`Saved ${data.scope} ${data.asset} revision ${data.revision} (${data.budgetHeader}). ${data.message ?? "Applies on Reload or a fresh session."}`);
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
      name: "list_scopes",
      label: "List Scopes",
      description: LIST_SCOPES_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => {
        const data = await call("list_scopes", {}) as any;
        if (data?.ok === false) throw new Error(data.error || "List scopes failed");
        const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
        if (scopes.length === 0) return textResult("No scopes found.");
        return textResult(scopes.map((s: any) => `- ${s.name} (${s.scope})`).join("\n"));
      },
    }),
    defineTool({
      name: "list_tasks",
      label: "List Tasks",
      description: LIST_TASKS_DESCRIPTION,
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskStatusFilter })),
        assignee: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskAssigneeFilter })),
        scope: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.scope })),
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
      parameters: Type.Object({
        taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }),
        scope: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.scope })),
      }),
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

  if (scopeKind === "room") {
    // Room: wait for all members. Tasks already in base list above.
    tools.push(defineTool({
      name: "wait",
      label: "Wait",
      description: WAIT_DESCRIPTION,
      parameters: Type.Object({
        member: Type.String({ description: "Target member name to wait on" }),
        timeoutMinutes: Type.Optional(Type.Number({ description: "Max minutes to wait (default 30, max 360)" })),
      }),
      execute: async (_id, params) => {
        const data = await call("wait", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Wait failed");
        if (data?.reason === "message") {
          const body = typeof data.message === "string" ? data.message : "";
          return textResult(`wait resolved: ${data.target} posted.\n\n${body}`);
        }
        if (data?.detail) return textResult(`wait resolved (${data.reason}): ${data.detail}`);
        return textResult(truncate(JSON.stringify(data, null, 2)));
      },
    }));

    tools.push(defineTool({
      name: "member_status",
      label: "Member Status",
      description: "Query live runtime status of room members. Returns each member's aggregated status — working / idle / inactive (inactive = no live runtime instance) — plus, for members with live instances, the scopes they are live in with per-scope status. Same source as the member panel status lamp. Read-only: never activates or notifies anyone.",
      parameters: Type.Object({
        member: Type.Optional(Type.String({ description: "Member name; omit for all room members" })),
      }),
      execute: async (_id, params) => {
        const data = await call("member_status", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Member status failed");
        const members = (data.members ?? []) as Array<{ name: string; status: string; activeScopes: Array<{ scope: string; status: string }> }>;
        const lines = members.map((m) => {
          const scopes = m.activeScopes.map((s) => `${s.scope} (${s.status})`).join(", ");
          return `- ${m.name}: ${m.status}${scopes ? ` — ${scopes}` : ""}`;
        });
        return textResult(lines.length ? lines.join("\n") : "No room members.");
      },
    }));
  } else {
    // DM: member directory + create/edit room (no wait/tasks in DM).
    tools.push(
      defineTool({
        name: "list_members",
        label: "List members",
        description: "List digital employees in this Bossmode (id, name, identity template). Use before create_room invites.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Optional name/id/template filter" })),
        }),
        execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("list_members", params as any), null, 2))),
      }),
      defineTool({
        name: "create_room",
        label: "Create room",
        description: "Create a project room. You become the leader. Invite members by global member id (from list_members). Optional initial room principles.",
        parameters: Type.Object({
          name: Type.String({ description: "Room display name" }),
          cwd: Type.Optional(Type.String({ description: "Working directory (default: current process cwd)" })),
          memberIds: Type.Optional(Type.Array(Type.String(), { description: "Global member ids to invite (mem_…)" })),
          principles: Type.Optional(Type.String({ description: "Initial room principles / announcement markdown" })),
        }),
        execute: async (_id, params) => {
          const data = await call("create_room", params as any) as any;
          if (data?.ok === false) throw new Error(data.error || "create_room failed");
          return textResult(truncate(JSON.stringify(data, null, 2)));
        },
      }),
      defineTool({
        name: "edit_room",
        label: "Edit room",
        description: "Leader-only: rename room, update principles, add/remove members by global member id.",
        parameters: Type.Object({
          roomId: Type.String({ description: "Room id to edit" }),
          name: Type.Optional(Type.String({ description: "New room name" })),
          principles: Type.Optional(Type.String({ description: "Replace room principles markdown" })),
          reason: Type.Optional(Type.String({ description: "Reason for principles change" })),
          addMemberIds: Type.Optional(Type.Array(Type.String(), { description: "Global member ids to invite" })),
          removeMemberIds: Type.Optional(Type.Array(Type.String(), { description: "Global member ids to remove (memory retained)" })),
        }),
        execute: async (_id, params) => {
          const data = await call("edit_room", params as any) as any;
          if (data?.ok === false) throw new Error(data.error || data.message || "edit_room failed");
          return textResult(truncate(JSON.stringify(data, null, 2)));
        },
      }),
    );

    // Strip room-only write tools from the DM surface (reads — list_tasks,
    // get_task — stay: they accept a target scope since 0.20.0 flagship ①).
    const dmDeny = new Set(["create_task", "update_task", "comment_task", "wait"]);
    for (let i = tools.length - 1; i >= 0; i--) {
      if (dmDeny.has(tools[i].name)) tools.splice(i, 1);
    }
  }

  // Defensive normalization: TypeBox omits `required` when every property is
  // optional — valid JSON Schema (OpenAI/xAI accept it), but some
  // OpenAI-compatible adapters (e.g. cloudrouter's OpenAI→Anthropic conversion)
  // silently return an empty stream for such tool schemas. Emit `required: []`
  // explicitly so every backend sees the most conservative shape.
  for (const tool of tools) {
    const parameters = tool.parameters as { type?: string; required?: unknown } | undefined;
    if (parameters && parameters.type === "object" && !Array.isArray(parameters.required)) {
      parameters.required = [];
    }
  }
  return tools;
}
