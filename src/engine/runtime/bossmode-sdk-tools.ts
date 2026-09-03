import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChatToolDescription, CHAT_MESSAGE_PARAM_DESCRIPTION } from "../../shared/chat-tool-description.js";
import { renderQueryRowsForMember } from "../query-render.js";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  LIST_SCOPES_DESCRIPTION,
  GET_TASK_DESCRIPTION,
  COMMENT_TASK_DESCRIPTION,
  WAIT_DESCRIPTION,
  RELOAD_DESCRIPTION,
  WORKSPACE_LIST_DESCRIPTION,
  WORKSPACE_CREATE_DESCRIPTION,
  WORKSPACE_USE_DESCRIPTION,
  WORKSPACE_REMOVE_DESCRIPTION,
  WORKSPACE_READ_DESCRIPTION,
  WORKSPACE_WRITE_DESCRIPTION,
  WORKSPACE_EDIT_DESCRIPTION,
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
        need_response: Type.Optional(Type.Array(Type.String(), { description: "Member names who must reply. Omit = FYI. Only listed @-mentioned members owe a reply debt." })),
        reply_to: Type.Optional(Type.String({ description: "Reference a message in this scope as msg:#<seq>. Posts a quote of the original; target must exist here." })),
      }),
      execute: async (_id, params) => {
        const data = await call("chat", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Chat failed");
        const note = data?.note ? `\n${data.note}` : "";
        return textResult("Message sent to room." + note);
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
        from_seq: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.from_seq })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.limit })),
        output: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.output })),
        scope: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.scope })),
      }),
      execute: async (_id, params) => {
        const data = await call("query_room_messages", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Query messages failed");
        if (data && typeof data === "object" && "path" in data) return textResult("Messages written to: " + data.path + " (count: " + data.count + ")");
        const messages = Array.isArray(data) ? data : [];
        // Member-view rendering (shared with file output): No./sender/time header,
        // replyTo quote block, content, attachment lines.
        return textResult(truncate(renderQueryRowsForMember(messages)));
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
        const data = await call("list_tasks", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Failed to load tasks");
        const tasks = Array.isArray(data) ? data : [];
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
    // ── Batch 7 P1: workspace tools + file tool overrides (read/write/edit
    // shadow pi's built-ins by name; relative paths follow the active
    // workspace root). File tool results pass through untouched so image
    // content blocks survive.
    defineTool({
      name: "workspace_list",
      label: "Workspace List",
      description: WORKSPACE_LIST_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_list", params as any), null, 2))),
    }),
    defineTool({
      name: "workspace_create",
      label: "Workspace Create",
      description: WORKSPACE_CREATE_DESCRIPTION,
      parameters: Type.Object({
        id: Type.String({ description: "Workspace id — letters, digits, dot, dash, underscore." }),
        host: Type.String({ description: PARAM_DESCRIPTIONS.sshHost }),
        user: Type.String({ description: PARAM_DESCRIPTIONS.sshUser }),
        port: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.sshPort })),
        keyPath: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.sshKeyPath })),
        root: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.sshRoot })),
        description: Type.Optional(Type.String({ description: "Short human-readable description." })),
      }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_create", params as any), null, 2))),
    }),
    defineTool({
      name: "workspace_use",
      label: "Workspace Use",
      description: WORKSPACE_USE_DESCRIPTION,
      parameters: Type.Object({ id: Type.String({ description: "Workspace id to activate." }) }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_use", params as any), null, 2))),
    }),
    defineTool({
      name: "workspace_remove",
      label: "Workspace Remove",
      description: WORKSPACE_REMOVE_DESCRIPTION,
      parameters: Type.Object({ id: Type.String({ description: "Workspace id to remove." }) }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_remove", params as any), null, 2))),
    }),
    defineTool({
      name: "read",
      label: "Read File",
      description: WORKSPACE_READ_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "File path — relative resolves against the active workspace root." }),
        offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)." })),
        limit: Type.Optional(Type.Number({ description: "Maximum lines to read (default 2000)." })),
        workspace: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.workspaceId })),
      }),
      execute: async (_id, params) => (await call("read", params as any)) as any,
    }),
    defineTool({
      name: "write",
      label: "Write File",
      description: WORKSPACE_WRITE_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "File path — relative resolves against the active workspace root." }),
        content: Type.String({ description: "Full file content to write." }),
        workspace: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.workspaceId })),
      }),
      execute: async (_id, params) => (await call("write", params as any)) as any,
    }),
    defineTool({
      name: "edit",
      label: "Edit File",
      description: WORKSPACE_EDIT_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "File path — relative resolves against the active workspace root." }),
        edits: Type.Array(Type.Object({
          oldText: Type.String({ description: "Exact text to find — must match exactly once." }),
          newText: Type.String({ description: "Replacement text." }),
        })),
        workspace: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.workspaceId })),
      }),
      execute: async (_id, params) => (await call("edit", params as any)) as any,
    }),
    defineTool({
      name: "reload",
      label: "Reload",
      description: RELOAD_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("reload", params as any), null, 2))),
    }),
  ];

  if (scopeKind === "room") {
    // Room: wait for all members. Tasks already in base list above.
    tools.push(defineTool({
      name: "create_topic",
      label: "Create topic",
      description: "Create a focused topic in this room. message is the first post (title is its first line; @-mentions activate those members). brief is an optional instruction injected into the topic guide (behavior boundary, e.g. research only — do not touch main).",
      parameters: Type.Object({
        message: Type.String({ description: "First topic message — becomes the topic title (first line) and is posted into the topic. @ a member to bring them in." }),
        brief: Type.Optional(Type.String({ description: "Optional topic instruction injected into the guide before the concurrency reminder." })),
      }),
      execute: async (_id, params) => {
        const data = await call("create_topic", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "create_topic failed");
        return textResult(`Topic created: ${data.title} (${data.scopeId})`);
      },
    }));

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
      description: "Query live runtime status of room members. Returns each member's aggregated status plus a room/topics breakdown — topics lists this member's live topic instances in the current room. Same source as the member panel status lamp. Read-only: never activates or notifies anyone.",
      parameters: Type.Object({
        member: Type.Optional(Type.String({ description: "Member name; omit for all room members" })),
      }),
      execute: async (_id, params) => {
        const data = await call("member_status", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Member status failed");
        const members = (data.members ?? []) as Array<{
          name: string; status: string; room?: string;
          topics?: Array<{ topicId: string; title: string; status: string }>;
          activeScopes: Array<{ scope: string; status: string }>;
        }>;
        const lines = members.map((m) => {
          const topicBits = (m.topics ?? []).map((t) => `${t.title} (${t.status})`).join(", ");
          const scopes = (m.activeScopes ?? []).map((s) => `${s.scope} (${s.status})`).join(", ");
          const extra = [
            m.room ? `room ${m.room}` : "",
            topicBits ? `topics: ${topicBits}` : "",
            scopes,
          ].filter(Boolean).join(" — ");
          return `- ${m.name}: ${m.status}${extra ? ` — ${extra}` : ""}`;
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
        description: "Create a project room. Invite members by global member id (from list_members). Optional initial room principles.",
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
        description: "Rename room, update principles, add/remove members by global member id. Any room member may call this.",
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
