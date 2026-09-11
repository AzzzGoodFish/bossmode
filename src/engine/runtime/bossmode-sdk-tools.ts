import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChatToolDescription, CHAT_MESSAGE_PARAM_DESCRIPTION } from "../../shared/chat-tool-description.js";
import { renderQueryRowsForMember } from "../query-render.js";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  LIST_SCOPES_DESCRIPTION,
  WAIT_DESCRIPTION,
  RELOAD_DESCRIPTION,
  WORKSPACE_LIST_DESCRIPTION,
  WORKSPACE_CREATE_DESCRIPTION,
  WORKSPACE_USE_DESCRIPTION,
  WORKSPACE_REMOVE_DESCRIPTION,
  WORKSPACE_READ_DESCRIPTION,
  WORKSPACE_WRITE_DESCRIPTION,
  WORKSPACE_EDIT_DESCRIPTION,
  SHELL_CREATE_DESCRIPTION,
  SHELL_EXEC_DESCRIPTION,
  SHELL_READ_DESCRIPTION,
  SHELL_WAIT_DESCRIPTION,
  SHELL_LIST_DESCRIPTION,
  SHELL_CLOSE_DESCRIPTION,
  BACKGROUND_START_DESCRIPTION,
  BACKGROUND_STATUS_DESCRIPTION,
  BACKGROUND_WAIT_DESCRIPTION,
  BACKGROUND_CANCEL_DESCRIPTION,
  RECALL_DESCRIPTION,
  MEMORIZE_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../shared/mcp-tool-descriptions.js";
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function truncate(text: string): string {
  const max = 25000;
  return text.length <= max ? text : text.slice(0, max) + `\n\n--- Result truncated (${text.length} chars). Use a more specific query. ---`;
}

/** Tools forbidden inside a background task session (same declarations stay
 *  registered so the fork prefix is unchanged; only execution is rejected). */
const BACKGROUND_FORBIDDEN_TOOLS = new Set([
  "chat",
  "wait",
  "background_start",
  "recall",
  "memorize",
]);

export function createBossmodeSdkTools(opts: {
  roomId: string;
  memberId: string;
  /** 0.20 scope kind — dm gets create_room/list_members; room gets wait/tasks. Default room. */
  scopeKind?: "dm" | "room";
  /** "background" = background task child session: same tool declarations, but
   *  scope-posting and background-start tools are rejected at execution time. */
  execution?: "live" | "background";
}): ToolDefinition[] {
  if (!opts.memberId) throw new Error("Trusted memberId is required to construct member tools.");
  const scopeKind = opts.scopeKind || "room";
  const call = async (tool: string, params: Record<string, any>, signal?: AbortSignal) => {
    if (opts.execution === "background" && BACKGROUND_FORBIDDEN_TOOLS.has(tool)) {
      throw new Error(`tool "${tool}" is not available inside a background task; finish the task and return the result as your final text`);
    }
    const { handleToolCallback } = await import("../tools.js");
    return handleToolCallback(tool, opts.roomId, opts.memberId, params, { memberId: opts.memberId, execution: opts.execution, ...(signal ? {signal} : {}) });
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: "chat",
      label: "Chat",
      description: buildChatToolDescription(),
      parameters: Type.Object({
        message: Type.String({ description: CHAT_MESSAGE_PARAM_DESCRIPTION }),
        attachments: Type.Optional(Type.Array(Type.String(), { description: "Local file paths to attach. Files are copied to the room's attachment store." })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("chat", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Chat failed");
        return textResult("Message sent to room.");
      },
    }),
    defineTool({
      name: "update_profile",
      label: "Update Profile",
      description: "Update your own member name or title. At least one field is required. An empty title clears it. Returns the committed profile and whether it changed.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "New member name." })),
        title: Type.Optional(Type.String({ description: "New member title; an empty string clears it." })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("update_profile", params as any) as any;
        // Keep structured validation/conflict details visible in SDK errors.
        if (data?.ok === false) throw new Error(JSON.stringify(data));
        return textResult(JSON.stringify(data));
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
    // ── Background tasks (foundation: start/status/wait/cancel + parameter-free memory entries) ──
    defineTool({
      name: "background_start",
      label: "Background Start",
      description: BACKGROUND_START_DESCRIPTION,
      parameters: Type.Object({
        prompt: Type.String({ description: PARAM_DESCRIPTIONS.backgroundPrompt }),
        sessionMode: Type.String({ description: PARAM_DESCRIPTIONS.backgroundSessionMode }),
      }),
      execute: async (_id, params) => {
        const data = await call("background_start", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Background start failed");
        return textResult(`Background task ${data.taskId} started (status: ${data.status}). Result is collected with background_wait.`);
      },
    }),
    defineTool({
      name: "background_status",
      label: "Background Status",
      description: BACKGROUND_STATUS_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => {
        const data = await call("background_status", {}) as any;
        if (data?.ok === false) throw new Error(data.error || "Background status failed");
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        if (tasks.length === 0) return textResult("No background tasks in this scope.");
        return textResult(tasks.map((t: any) => `[${t.status}] ${t.kind} ${t.taskId} started ${t.startedAt}${t.endedAt ? ` ended ${t.endedAt}` : ""}`).join("\n"));
      },
    }),
    defineTool({
      name: "background_wait",
      label: "Background Wait",
      description: BACKGROUND_WAIT_DESCRIPTION,
      parameters: Type.Object({
        taskId: Type.String({ description: PARAM_DESCRIPTIONS.backgroundTaskId }),
        blockMs: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.backgroundBlockMs })),
      }),
      execute: async (_id, params, signal) => {
        const data = await call("background_wait", params as any, signal) as any;
        if (data?.ok === false) throw new Error(data.error || "Background wait failed");
        if (data.status === "running" || data.status === "starting" || data.status === "cancelling") {
          return textResult(`Task ${data.taskId} is still ${data.status}. ${data.note ?? ""}`.trim());
        }
        if (data.status === "done") return textResult(truncate(`Result:\n${data.result ?? ""}`));
        return textResult(`Task ${data.taskId} ${data.status}. Reason: ${data.error ?? "(none)"}`);
      },
    }),
    defineTool({
      name: "background_cancel",
      label: "Background Cancel",
      description: BACKGROUND_CANCEL_DESCRIPTION,
      parameters: Type.Object({
        taskId: Type.String({ description: PARAM_DESCRIPTIONS.backgroundTaskId }),
      }),
      execute: async (_id, params) => {
        const data = await call("background_cancel", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Background cancel failed");
        return textResult(`Task ${data.taskId}: ${data.status}${data.note ? ` (${data.note})` : ""}.`);
      },
    }),
    defineTool({
      name: "recall",
      label: "Recall",
      description: RECALL_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => {
        const data = await call("recall", {}) as any;
        if (data?.ok === false) throw new Error(data.error || "Recall failed");
        return textResult(`Recall task ${data.taskId} started (status: ${data.status}). Collect findings with background_wait.`);
      },
    }),
    defineTool({
      name: "memorize",
      label: "Memorize",
      description: MEMORIZE_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => {
        const data = await call("memorize", {}) as any;
        if (data?.ok === false) throw new Error(data.error || "Memorize failed");
        return textResult(`Memorize task ${data.taskId} started (status: ${data.status}). Collect the change report with background_wait.`);
      },
    }),
    // ── Batch 7 P2: persistent shells (real PTYs; bash is retired).
    defineTool({
      name: "shell_create",
      label: "Shell Create",
      description: SHELL_CREATE_DESCRIPTION,
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.shellName })),
        workspace: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.workspaceId })),
        cwd: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.shellCwd })),
      }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("shell_create", params as any), null, 2))),
    }),
    defineTool({
      name: "shell_exec",
      label: "Shell Exec",
      description: SHELL_EXEC_DESCRIPTION,
      parameters: Type.Object({
        shell: Type.String({ description: "Shell id from shell_create / shell_list." }),
        command: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.shellCommand })),
        keys: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.shellKeys })),
        blockUntilMs: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.shellBlockUntilMs })),
      }),
      execute: async (_id, params, signal) => textResult(truncate(JSON.stringify(await call("shell_exec", params as any, signal), null, 2))),
    }),
    defineTool({
      name: "shell_read",
      label: "Shell Read",
      description: SHELL_READ_DESCRIPTION,
      parameters: Type.Object({
        shell: Type.String({ description: "Shell id." }),
        exec: Type.Optional(Type.String({ description: "Exec id (e.g. e3) — returns that command's lines." })),
        fromLine: Type.Optional(Type.Number({ description: "First absolute line number to read." })),
        toLine: Type.Optional(Type.Number({ description: "Last absolute line number to read." })),
      }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("shell_read", params as any), null, 2))),
    }),
    defineTool({
      name: "shell_wait",
      label: "Shell Wait",
      description: SHELL_WAIT_DESCRIPTION,
      parameters: Type.Object({
        shell: Type.String({ description: "Shell id." }),
        exec: Type.String({ description: "Exec id (e.g. e3) — the command to wait for." }),
        blockUntilMs: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.shellWaitBlockUntilMs })),
      }),
      execute: async (_id, params, signal) => textResult(truncate(JSON.stringify(await call("shell_wait", params as any, signal), null, 2))),
    }),
    defineTool({
      name: "shell_list",
      label: "Shell List",
      description: SHELL_LIST_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("shell_list", params as any), null, 2))),
    }),
    defineTool({
      name: "shell_close",
      label: "Shell Close",
      description: SHELL_CLOSE_DESCRIPTION,
      parameters: Type.Object({ shell: Type.String({ description: "Shell id to close." }) }),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("shell_close", params as any), null, 2))),
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
      name: "wait",
      label: "Wait",
      description: WAIT_DESCRIPTION,
      parameters: Type.Object({
        member: Type.String({ description: "Target member name to wait on" }),
        timeoutMinutes: Type.Optional(Type.Number({ description: "Max minutes to wait (default 30, max 360)" })),
      }),
      execute: async (_id, params, signal) => {
        const data = await call("wait", params as any, signal) as any;
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
      description: "Query live runtime status of room members. Returns each member's aggregated status plus a room breakdown. Same source as the member panel status lamp. Read-only: never activates or notifies anyone.",
      parameters: Type.Object({
        member: Type.Optional(Type.String({ description: "Member name; omit for all room members" })),
      }),
      execute: async (_id, params) => {
        const data = await call("member_status", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "Member status failed");
        const members = (data.members ?? []) as Array<{
          name: string; status: string; room?: string;
          activeScopes: Array<{ scope: string; status: string }>;
        }>;
        const lines = members.map((m) => {
          const scopes = (m.activeScopes ?? []).map((s) => `${s.scope} (${s.status})`).join(", ");
          const extra = [
            m.room ? `room ${m.room}` : "",
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
    const dmDeny = new Set(["wait"]);
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
