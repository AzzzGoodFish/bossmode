export interface AgentEvent {
  type: string;
  ts?: number;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  text?: string;
  thinking?: string;
  usage?: unknown;
  [key: string]: unknown;
}

export type ActionKind = "tool-running" | "tool-done" | "tool-error" | "thinking" | "reply" | "system" | "idle";

export interface ActionSummary {
  kind: ActionKind;
  label: string;
  detail: string;
  ts?: number;
}

export function isDurableAgentEvent(event: AgentEvent): boolean {
  return event.type !== "message_update" && event.type !== "tool_update" && event.type !== "message_start";
}

export function isStationActionEvent(event: AgentEvent): boolean {
  return isDurableAgentEvent(event);
}

export function formatEventTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function truncateText(value: unknown, max = 72): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

function argsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

export interface ToolDisplay {
  label: string;
  detail: string;
}

function stringArg(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function mcpToolDisplay(args: unknown): ToolDisplay | null {
  const obj = argsObject(args);
  const action = stringArg(obj, "action").toLowerCase();
  const command = stringArg(obj, "command").toLowerCase();
  const mode = action || command;
  if (obj.search != null || mode === "search") return { label: "MCP search", detail: truncateText(obj.search ?? obj.query ?? obj.pattern ?? "", 64) };
  if (obj.describe != null || mode === "describe") return { label: "MCP describe", detail: truncateText(obj.describe ?? obj.tool ?? obj.name ?? "", 64) };
  if (obj.connect != null || mode === "connect") return { label: "MCP connect", detail: truncateText(obj.connect ?? obj.server ?? obj.name ?? "", 64) };
  if (obj.tool != null || obj.toolName != null || mode === "call") return { label: "MCP call", detail: truncateText(obj.tool ?? obj.toolName ?? obj.name ?? "", 64) };
  return null;
}

export function toolDisplay(toolName: unknown, args: unknown): ToolDisplay {
  const tool = String(toolName || "tool");
  if (tool.toLowerCase() === "mcp") {
    return mcpToolDisplay(args) || { label: "MCP", detail: toolTarget(args) };
  }
  return { label: tool, detail: toolTarget(args) };
}

export function toolTarget(args: unknown): string {
  const obj = argsObject(args);
  const mcp = mcpToolDisplay(args);
  if (mcp) return mcp.detail;
  return truncateText(obj.file_path ?? obj.path ?? obj.command ?? obj.pattern ?? obj.url ?? "", 64);
}

export function summarizeAgentEvent(event?: AgentEvent): ActionSummary {
  if (!event) return { kind: "idle", label: "IDLE", detail: "No recent activity" };
  const ts = typeof event.ts === "number" ? event.ts : undefined;
  if (event.type === "tool_start") {
    const tool = toolDisplay(event.toolName, event.args);
    return { kind: "tool-running", label: `RUNNING · ${tool.label}`, detail: tool.detail || "running", ts };
  }
  if (event.type === "tool_end") {
    const tool = toolDisplay(event.toolName, event.args);
    if (event.isError) {
      return { kind: "tool-error", label: `ERROR · ${tool.label}`, detail: truncateText(event.result ?? event.text ?? "failed", 78), ts };
    }
    return { kind: "tool-done", label: `DONE · ${tool.label}`, detail: tool.detail || truncateText(event.result ?? event.text ?? "completed", 78), ts };
  }
  if ((event.type === "message_end" || event.type === "message_update") && event.text) {
    return { kind: "reply", label: event.type === "message_update" ? "DRAFT" : "REPLY", detail: truncateText(event.text, 78), ts };
  }
  if ((event.type === "message_end" || event.type === "message_update") && event.thinking) {
    return { kind: "thinking", label: "THINKING", detail: truncateText(event.thinking, 78), ts };
  }
  if (event.type === "agent_reply") return { kind: "reply", label: "REPLY", detail: truncateText(event.text, 78), ts };
  if (event.type === "user_steer") return { kind: "reply", label: "STEER", detail: truncateText(event.text, 78), ts };
  if (event.type === "agent_start") return { kind: "system", label: "TURN", detail: "Agent started", ts };
  if (event.type === "agent_end") return { kind: "system", label: "TURN", detail: "Agent finished", ts };
  return { kind: "system", label: event.type.toUpperCase(), detail: truncateText(event.text ?? event.type, 78), ts };
}

export function latestActionSummary(events: AgentEvent[]): ActionSummary {
  const durable = [...events].reverse().find(isStationActionEvent);
  return summarizeAgentEvent(durable);
}

export function eventSearchText(event: AgentEvent): string {
  const obj = argsObject(event.args);
  return [
    event.type,
    event.toolName,
    obj.command,
    obj.action,
    obj.search,
    obj.describe,
    obj.connect,
    obj.tool,
    obj.toolName,
    obj.query,
    obj.file_path,
    obj.path,
    event.text,
    event.thinking,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function isToolEvent(event: AgentEvent): boolean {
  return event.type === "tool_start" || event.type === "tool_end";
}

export function isReplyEvent(event: AgentEvent): boolean {
  return event.type === "message_end" || event.type === "agent_reply" || event.type === "user_steer";
}

export function diffStatForTool(event: AgentEvent): { added: number; removed: number } | null {
  if (event.type !== "tool_start") return null;
  const name = String(event.toolName || "").toLowerCase();
  const args = argsObject(event.args);
  if (name.includes("edit") && typeof args.old_string === "string" && typeof args.new_string === "string") {
    return { added: countLines(args.new_string), removed: countLines(args.old_string) };
  }
  if (name.includes("write") && typeof args.content === "string") {
    return { added: countLines(args.content), removed: 0 };
  }
  return null;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}
