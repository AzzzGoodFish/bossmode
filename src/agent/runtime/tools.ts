import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { terminalToolResult } from "./tool-output.js";
import { renderQueryRowsForMember } from "../tools.js";
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

function buildGatewayEntries(call:CallFn):GatewayEntry[]{
  return GATEWAY_TOOL_SPECS.map(spec=>({...spec,execute:async(_id,params,signal)=>{
    const data=await call(spec.name,params,signal) as any;
    if(data?.ok===false)throw new Error(data.error||data.message||`${spec.name} failed`);
    return textResult(truncate(JSON.stringify(data,null,2)));
  }}));
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
  memberId: string;
  /** Opaque source of the batch currently being executed. */
  resolveSourceRef: () => string | null;
}): ToolDefinition[] {
  if (!opts.memberId) throw new Error("Trusted memberId is required to construct member tools.");
  const call = async (tool: string, params: Record<string, any>, signal?: AbortSignal) => {
    const sourceRef = opts.resolveSourceRef();
    const needsCurrentChat = (tool === "chat_send" && !String(params?.to ?? "").trim())
      || ((tool === "chat_read" || tool === "chat_search") && !String(params?.chat ?? "").trim());
    if (!sourceRef && needsCurrentChat) throw new Error("This tool call needs a current chat or an explicit target");
    const { handleToolCallback } = await import("../tools.js");
    return handleToolCallback(tool, sourceRef ?? "", opts.memberId, params, { memberId: opts.memberId, ...(signal ? {signal} : {}) });
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
        const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
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
        const hits = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
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
    ...(["workspace_list","workspace_create","workspace_use","workspace_remove","terminal_create","terminal_list","terminal_close","reload"] as const).map(name=>defineTool({
      ...specOf(name),execute:async(_id,params)=>textResult(truncate(JSON.stringify(await call(name,params as any),null,2))),
    })),
    ...(["read","write","edit"] as const).map(name=>defineTool({...specOf(name),execute:async(_id,params)=>(await call(name,params as any)) as any})),
    ...(["terminal_exec","terminal_read","terminal_wait"] as const).map(name=>defineTool({
      ...specOf(name),execute:async(_id,params,signal)=>terminalToolResult(await call(name,params as any,signal)),
    })),
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
