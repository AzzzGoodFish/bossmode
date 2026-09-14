import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { buildChatSendToolDescription, CHAT_SEND_TO_PARAM_DESCRIPTION, CHAT_SEND_MESSAGE_PARAM_DESCRIPTION, CHAT_SEND_ATTACHMENTS_PARAM_DESCRIPTION } from "../../shared/chat-tool-description.js";
import { renderQueryRowsForMember } from "../query-render.js";
import {
  CHAT_READ_DESCRIPTION,
  CHAT_SEARCH_DESCRIPTION,
  CHAT_LIST_DESCRIPTION,
  BOSSMODE_GATEWAY_DESCRIPTION,
  CHAT_INFO_DESCRIPTION,
  CHAT_CREATE_DESCRIPTION,
  CHAT_EDIT_DESCRIPTION,
  MEMBER_LIST_DESCRIPTION,
  MEMBER_INFO_DESCRIPTION,
  PROFILE_READ_DESCRIPTION,
  PROFILE_UPDATE_DESCRIPTION,
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
  PARAM_DESCRIPTIONS,
} from "../../shared/mcp-tool-descriptions.js";
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function truncate(text: string): string {
  const max = 25000;
  return text.length <= max ? text : text.slice(0, max) + `\n\n--- Result truncated (${text.length} chars). Use a more specific query. ---`;
}

type CallFn = (tool: string, params: Record<string, any>, signal?: AbortSignal) => Promise<unknown>;

/**
 * Batch 3 (member-centric): gateway capabilities. Each entry is a full tool
 * definition minus registration — `bossmode` exposes them via list/describe/call
 * and `call` executes through the same dispatch path as a direct tool.
 */
interface GatewayEntry {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  example: Record<string, unknown>;
  execute: (id: string, params: Record<string, any>, signal?: AbortSignal) => Promise<any>;
}

function requiredOf(schema: TSchema): string[] {
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.map(String) : [];
}

function buildGatewayEntries(call: CallFn): GatewayEntry[] {
  const entries: GatewayEntry[] = [
    {
      name: "chat_info",
      label: "Chat Info",
      description: CHAT_INFO_DESCRIPTION,
      parameters: Type.Object({
        chat: Type.String({ description: PARAM_DESCRIPTIONS.chatRef }),
      }, { additionalProperties: false }),
      example: { chat: "user" },
      execute: async (_id, params) => {
        const data = await call("chat_info", params) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_info failed");
        const chat = data.chat;
        const lines = [`${chat.name} — ${chat.kind === "room" ? "group chat" : "private chat"} (${chat.id})`];
        if (chat.description) lines.push(chat.description);
        if (Array.isArray(chat.members) && chat.members.length > 0) {
          lines.push(`members: ${chat.members.map((m: any) => m.name).join(", ")}`);
        }
        return textResult(truncate(lines.join("\n")));
      },
    },
    {
      name: "chat_create",
      label: "Chat Create",
      description: CHAT_CREATE_DESCRIPTION,
      parameters: Type.Object({
        name: Type.String({ description: "Chat name." }),
        description: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.chatDescription })),
        members: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.createMembers })),
      }, { additionalProperties: false }),
      example: { name: "<group chat name>" },
      execute: async (_id, params) => {
        const data = await call("chat_create", params) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_create failed");
        const members = Array.isArray(data.members) && data.members.length > 0
          ? ` Members: ${data.members.map((m: any) => m.name).join(", ")}.`
          : "";
        return textResult(`Created group chat "${data.chat.name}" (${data.chat.id}).${members}`);
      },
    },
    {
      name: "chat_edit",
      label: "Chat Edit",
      description: CHAT_EDIT_DESCRIPTION,
      parameters: Type.Object({
        chat: Type.String({ description: PARAM_DESCRIPTIONS.chatRef }),
        name: Type.Optional(Type.String({ description: "New chat name." })),
        description: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.chatDescription })),
        add_members: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.addMembers })),
        remove_members: Type.Optional(Type.Array(Type.String(), { description: PARAM_DESCRIPTIONS.removeMembers })),
      }, { additionalProperties: false }),
      example: { chat: "<chat id or name>", name: "<new name>" },
      execute: async (_id, params) => {
        const data = await call("chat_edit", params) as any;
        if (data?.ok === false) throw new Error(data.error || data.message || "chat_edit failed");
        const parts = [`Updated "${data.chat.name}" (${data.chat.id}).`];
        if (Array.isArray(data.added) && data.added.length > 0) parts.push(`Added: ${data.added.join(", ")}.`);
        if (Array.isArray(data.removed) && data.removed.length > 0) parts.push(`Removed: ${data.removed.join(", ")}.`);
        return textResult(parts.join(" "));
      },
    },
    {
      name: "member_list",
      label: "Member List",
      description: MEMBER_LIST_DESCRIPTION,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.listQuery })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.listLimit })),
        offset: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.listOffset })),
      }, { additionalProperties: false }),
      example: {},
      execute: async (_id, params) => {
        const data = await call("member_list", params) as any;
        if (data?.ok === false) throw new Error(data.error || "member_list failed");
        const members = Array.isArray(data?.members) ? data.members : [];
        if (members.length === 0) return textResult("No members found.");
        const lines = members.map((m: any) => `- ${m.name} (${m.id})${m.description ? ` — ${m.description}` : ""}`);
        const total = typeof data.total === "number" ? data.total : members.length;
        if (total > members.length) {
          const next = Number(params.offset ?? 0) + members.length;
          lines.push(`Showing ${members.length} of ${total}. Use offset=${next} for the next page.`);
        }
        return textResult(truncate(lines.join("\n")));
      },
    },
    {
      name: "member_info",
      label: "Member Info",
      description: MEMBER_INFO_DESCRIPTION,
      parameters: Type.Object({
        member: Type.String({ description: PARAM_DESCRIPTIONS.memberRef }),
      }, { additionalProperties: false }),
      example: { member: "<member name or id>" },
      execute: async (_id, params) => {
        const data = await call("member_info", params) as any;
        if (data?.ok === false) throw new Error(data.error || "member_info failed");
        const member = data.member;
        const lines = [`${member.name} (${member.id}) — ${member.status}`];
        if (member.description) lines.push(member.description);
        return textResult(lines.join("\n"));
      },
    },
    {
      name: "profile_read",
      label: "Profile Read",
      description: PROFILE_READ_DESCRIPTION,
      parameters: Type.Object({}, { additionalProperties: false }),
      example: {},
      execute: async (_id, params) => {
        const data = await call("profile_read", params) as any;
        if (data?.ok === false) throw new Error(data.error || "profile_read failed");
        const member = data.member;
        const lines = [`${member.name} (${member.id})`];
        if (member.description) lines.push(member.description);
        return textResult(lines.join("\n"));
      },
    },
    {
      name: "profile_update",
      label: "Profile Update",
      description: PROFILE_UPDATE_DESCRIPTION,
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.profileName })),
        description: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.profileDescription })),
      }, { additionalProperties: false }),
      example: { description: "<your description>" },
      execute: async (_id, params) => {
        const data = await call("profile_update", params) as any;
        // Keep structured validation/conflict details visible in SDK errors.
        if (data?.ok === false) throw new Error(JSON.stringify(data));
        return textResult(JSON.stringify(data));
      },
    },
  ];
  return entries;
}

function renderGatewayList(entries: GatewayEntry[]): string {
  const lines = entries.map((entry) => `- ${entry.name} — ${entry.description.split("\n")[0]}`);
  return `${lines.join("\n")}\nUse {action:"describe", tool:"<name>"} for one capability's parameters.`;
}

function renderGatewayDescribe(entry: GatewayEntry): string {
  return [
    `${entry.name}: ${entry.description}`,
    "",
    "parameters:",
    JSON.stringify(entry.parameters, null, 2),
    "",
    `call: {"action":"call","tool":"${entry.name}","args":${JSON.stringify(entry.example)}}`,
  ].join("\n");
}

export function createBossmodeSdkTools(opts: {
  roomId: string;
  memberId: string;
  /** Retained for call-site compatibility — the tool surface no longer varies by scope kind (batch 3). */
  scopeKind?: "dm" | "room";
}): ToolDefinition[] {
  if (!opts.memberId) throw new Error("Trusted memberId is required to construct member tools.");
  const call = async (tool: string, params: Record<string, any>, signal?: AbortSignal) => {
    const { handleToolCallback } = await import("../tools.js");
    return handleToolCallback(tool, opts.roomId, opts.memberId, params, { memberId: opts.memberId, ...(signal ? {signal} : {}) });
  };

  // ── Hot tools: registered directly (chat send/read/search/list) ──
  const tools: ToolDefinition[] = [
    defineTool({
      name: "chat_send",
      label: "Chat Send",
      description: buildChatSendToolDescription(),
      parameters: Type.Object({
        to: Type.String({ description: CHAT_SEND_TO_PARAM_DESCRIPTION }),
        message: Type.String({ description: CHAT_SEND_MESSAGE_PARAM_DESCRIPTION }),
        attachments: Type.Optional(Type.Array(Type.String(), { description: CHAT_SEND_ATTACHMENTS_PARAM_DESCRIPTION })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("chat_send", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_send failed");
        const name = data?.chat?.name ? ` to "${data.chat.name}"` : "";
        return textResult(`Message sent${name}.`);
      },
    }),
    defineTool({
      name: "chat_read",
      label: "Chat Read",
      description: CHAT_READ_DESCRIPTION,
      parameters: Type.Object({
        chat: Type.String({ description: PARAM_DESCRIPTIONS.chatRef }),
        from_seq: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.from_seq })),
        around_seq: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.around_seq })),
        before: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.before })),
        after: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.after })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.limit })),
        output: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.output })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("chat_read", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_read failed");
        if (data && typeof data === "object" && "path" in data) return textResult("Messages written to: " + data.path + " (count: " + data.count + ")");
        const messages = Array.isArray(data) ? data : [];
        // Member-view rendering (shared with file output): No./sender/time header,
        // replyTo quote block, content, attachment lines.
        return textResult(truncate(renderQueryRowsForMember(messages)));
      },
    }),
    defineTool({
      name: "chat_search",
      label: "Chat Search",
      description: CHAT_SEARCH_DESCRIPTION,
      parameters: Type.Object({
        chat: Type.String({ description: PARAM_DESCRIPTIONS.chatRef }),
        query: Type.String({ description: PARAM_DESCRIPTIONS.query }),
        from: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.from })),
        before: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.before })),
        after: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.after })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.limit })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("chat_search", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_search failed");
        const hits = Array.isArray(data) ? data : [];
        return textResult(truncate(renderQueryRowsForMember(hits)));
      },
    }),
    defineTool({
      name: "chat_list",
      label: "Chat List",
      description: CHAT_LIST_DESCRIPTION,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.listQuery })),
        limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.listLimit })),
        offset: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.listOffset })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const data = await call("chat_list", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_list failed");
        const chats = Array.isArray(data?.chats) ? data.chats : [];
        if (chats.length === 0) return textResult("No chats found.");
        const lines = chats.map((c: any) => `- ${c.name} (${c.id}) [${c.kind === "room" ? "group chat" : "private chat"}]${c.description ? ` — ${c.description}` : ""}`);
        const total = typeof data.total === "number" ? data.total : chats.length;
        if (total > chats.length) {
          const next = Number(params.offset ?? 0) + chats.length;
          lines.push(`Showing ${chats.length} of ${total}. Use offset=${next} for the next page.`);
        }
        return textResult(truncate(lines.join("\n")));
      },
    }),
    // ── Gateway: long-tail capabilities via list/describe/call ──
    defineTool({
      name: "bossmode",
      label: "Bossmode",
      description: BOSSMODE_GATEWAY_DESCRIPTION,
      parameters: Type.Object({
        action: Type.String({ description: PARAM_DESCRIPTIONS.gatewayAction }),
        tool: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.gatewayTool })),
        args: Type.Optional(Type.Any({ description: PARAM_DESCRIPTIONS.gatewayArgs })),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => {
        const entries = buildGatewayEntries(call);
        const action = String(params?.action ?? "").trim().toLowerCase();
        if (action === "list") return textResult(truncate(renderGatewayList(entries)));

        const toolName = typeof params?.tool === "string" ? params.tool.trim() : "";
        if (action !== "describe" && action !== "call") {
          return textResult(`[error] unknown action "${action || "(missing)"}" — use {action:"list"}, {action:"describe", tool:"<name>"} or {action:"call", tool:"<name>", args:{…}}.`);
        }
        const entry = entries.find((candidate) => candidate.name === toolName);
        if (!entry) {
          return textResult(`[error] unknown tool "${toolName || "(missing)"}" — available: ${entries.map((candidate) => candidate.name).join(", ")}. Use {action:"describe", tool:"<name>"} for parameters.`);
        }
        if (action === "describe") return textResult(truncate(renderGatewayDescribe(entry)));

        const args = params?.args ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return textResult(`[error] "args" must be an object — call: {"action":"call","tool":"${entry.name}","args":${JSON.stringify(entry.example)}}`);
        }
        const missing = requiredOf(entry.parameters).filter((key) => !(key in (args as Record<string, unknown>)));
        if (missing.length > 0) {
          return textResult(`[error] the "${entry.name}" tool requires ${missing.map((key) => `\`${key}\``).join(", ")}.`);
        }
        return await entry.execute("gateway", args as Record<string, any>, signal);
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
