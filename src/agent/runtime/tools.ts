import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { renderQueryRowsForMember } from "../tools/query-render.js";
import {
  DIRECT_TOOL_SPECS,
  GATEWAY_TOOL_SPECS,
  type DirectToolSpec,
  type GatewayToolSpec,
} from "../tools.js";
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
type GatewayEntry = GatewayToolSpec & {
  execute: (id: string, params: Record<string, any>, signal?: AbortSignal) => Promise<any>;
};

function requiredOf(schema: TSchema): string[] {
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.map(String) : [];
}

function buildGatewayEntries(call: CallFn): GatewayEntry[] {
  const specs = new Map(GATEWAY_TOOL_SPECS.map((spec) => [spec.name, spec]));
  const specOf = (name: GatewayToolSpec["name"]): GatewayToolSpec => {
    const spec = specs.get(name);
    if (!spec) throw new Error(`Gateway spec missing for "${name}"`);
    return spec;
  };
  const entries: GatewayEntry[] = [
    {
      ...specOf("chat_info"),
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
      ...specOf("chat_create"),
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
      ...specOf("chat_edit"),
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
      ...specOf("member_list"),
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
      ...specOf("member_info"),
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
      ...specOf("profile_read"),
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
      ...specOf("profile_update"),
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
  /** Chat this instance was built for; the fallback when no live resolver is given. */
  roomId: string;
  memberId: string;
  /** Retained for call-site compatibility — the tool surface no longer varies by scope kind (batch 3). */
  scopeKind?: "dm" | "room";
  /** ① B1: a member has one instance across chats, so tool calls must target the
   *  chat of the turn being processed, not the one the instance was built for.
   *  Resolved per call; defaults to `roomId`. */
  resolveChatId?: () => string;
}): ToolDefinition[] {
  if (!opts.memberId) throw new Error("Trusted memberId is required to construct member tools.");
  const chatIdOf = () => opts.resolveChatId?.() || opts.roomId;
  const call = async (tool: string, params: Record<string, any>, signal?: AbortSignal) => {
    const { handleToolCallback } = await import("../tools/tools.js");
    return handleToolCallback(tool, chatIdOf(), opts.memberId, params, { memberId: opts.memberId, ...(signal ? {signal} : {}) });
  };

  const specs = new Map(DIRECT_TOOL_SPECS.map((spec) => [spec.name, spec]));
  const specOf = (name: DirectToolSpec["name"]): DirectToolSpec => {
    const spec = specs.get(name);
    if (!spec) throw new Error(`Direct tool spec missing for "${name}"`);
    return spec;
  };

  // ── Hot tools: registered directly (chat send/read/search/list) ──
  const tools: ToolDefinition[] = [
    defineTool({
      ...specOf("chat_send"),
      execute: async (_id, params) => {
        const data = await call("chat_send", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_send failed");
        const name = data?.chat?.name ? ` to "${data.chat.name}"` : "";
        return textResult(`Message sent${name}.`);
      },
    }),
    defineTool({
      ...specOf("chat_read"),
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
      ...specOf("chat_search"),
      execute: async (_id, params) => {
        const data = await call("chat_search", params as any) as any;
        if (data?.ok === false) throw new Error(data.error || "chat_search failed");
        const hits = Array.isArray(data) ? data : [];
        return textResult(truncate(renderQueryRowsForMember(hits)));
      },
    }),
    defineTool({
      ...specOf("chat_list"),
      execute: async (_id, params: any) => {
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
      ...specOf("bossmode"),
      execute: async (_id, params: any, signal) => {
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
      ...specOf("workspace_list"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_list", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("workspace_create"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_create", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("workspace_use"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_use", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("workspace_remove"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("workspace_remove", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("read"),
      execute: async (_id, params) => (await call("read", params as any)) as any,
    }),
    defineTool({
      ...specOf("write"),
      execute: async (_id, params) => (await call("write", params as any)) as any,
    }),
    defineTool({
      ...specOf("edit"),
      execute: async (_id, params) => (await call("edit", params as any)) as any,
    }),
    // ── Batch 7 P2: persistent terminals (real PTYs; bash is retired).
    defineTool({
      ...specOf("terminal_create"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("terminal_create", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("terminal_exec"),
      execute: async (_id, params, signal) => textResult(truncate(JSON.stringify(await call("terminal_exec", params as any, signal), null, 2))),
    }),
    defineTool({
      ...specOf("terminal_read"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("terminal_read", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("terminal_wait"),
      execute: async (_id, params, signal) => textResult(truncate(JSON.stringify(await call("terminal_wait", params as any, signal), null, 2))),
    }),
    defineTool({
      ...specOf("terminal_list"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("terminal_list", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("terminal_close"),
      execute: async (_id, params) => textResult(truncate(JSON.stringify(await call("terminal_close", params as any), null, 2))),
    }),
    defineTool({
      ...specOf("reload"),
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
