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

/** Activity-stream visibility (member Activity tab + workstations feed):
 * streaming deltas (message_update/tool_update) and message_start markers are
 * noise; a bare message_end from a pure tool-call round (no text, no thinking)
 * carries no information either — excluded per fish 2026-08-09. message_end
 * WITH text/thinking still renders as the REPLY/THINKING cards. */
export function isActivityStreamEvent(event: AgentEvent): boolean {
  if (event.type === "message_update" || event.type === "tool_update" || event.type === "message_start") return false;
  if (event.type === "message_end" && !event.text && !event.thinking) return false;
  return true;
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

const SENSITIVE_ARG_KEY = /(?:authorization|password|token|secret|credential|api[_-]?key|x-api-key|cookie|session)/i;
const JSON_CONTAINER_RE = /^\s*[\[{]/;

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:authorization|x-api-key|api[_-]?key|token|secret|password|credential|cookie|session)\s*[=:]\s*["']?)([^"'\s,}\\]+)/gi, "$1[redacted]")
    .replace(/("(?:authorization|x-api-key|api[_-]?key|token|secret|password|credential|cookie|session)"\s*:\s*")([^"]*)"/gi, "$1[redacted]\"");
}

function sanitizeStringPreview(value: string, depth: number): unknown {
  if (depth <= 4 && JSON_CONTAINER_RE.test(value)) {
    try {
      return sanitizeArgPreview(JSON.parse(value), depth + 1);
    } catch {
      // Fall through to regex redaction for malformed/stringified snippets.
    }
  }
  return truncateText(redactSensitiveString(value), 160);
}

function sanitizeArgPreview(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeStringPreview(value, depth);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => sanitizeArgPreview(item, depth + 1));
    return value.length > 8 ? [...items, `… ${value.length - 8} more`] : items;
  }
  if (typeof value === "object") {
    if (depth > 4) return "…";
    const entries = Object.entries(value as Record<string, unknown>);
    const previewEntries = entries.slice(0, 16).map(([key, item]) => [key, SENSITIVE_ARG_KEY.test(key) ? "[redacted]" : sanitizeArgPreview(item, depth + 1)]);
    if (entries.length > 16) previewEntries.push(["…", `${entries.length - 16} more keys`]);
    return Object.fromEntries(previewEntries);
  }
  return truncateText(String(value), 160);
}

export function formatToolArgsPreview(args: unknown): string {
  return JSON.stringify(sanitizeArgPreview(args), null, 2);
}

/** Full-depth redact without preview truncation — for the expandable Arguments panel. */
function sanitizeArgsFull(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeArgsFull(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 12) return "…";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_ARG_KEY.test(key) ? "[redacted]" : sanitizeArgsFull(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function formatToolArgsFull(args: unknown): string {
  return JSON.stringify(sanitizeArgsFull(args), null, 2);
}

export function getSanitizedArgs(args: unknown): unknown {
  return sanitizeArgsFull(args);
}

export function compactionReasonLabel(reason: unknown): string {
  if (reason === "threshold") return "auto · threshold";
  if (reason === "overflow") return "context overflow";
  if (reason === "manual") return "manual";
  return reason ? String(reason) : "context";
}

export function compactionEndDetail(event: AgentEvent): string {
  const tokens = typeof event.tokensBefore === "number" ? `tokens before: ${event.tokensBefore}` : "context";
  const retry = event.willRetry ? " · will retry" : "";
  if (event.errorMessage) return `${truncateText(event.errorMessage, 72)}${retry}`;
  if (event.aborted) return `aborted${retry}`;
  const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : null;
  return truncateText(result?.summary ?? tokens, 78);
}

export function formatCompactionPreview(event: AgentEvent): string {
  const result = event.result !== undefined ? event.result : {
    reason: event.reason,
    aborted: event.aborted,
    willRetry: event.willRetry,
    errorMessage: event.errorMessage,
    tokensBefore: event.tokensBefore,
  };
  return JSON.stringify(sanitizeArgPreview(result), null, 2);
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
  if (event.type === "compaction_start") {
    return { kind: "tool-running", label: "COMPACTING · context", detail: compactionReasonLabel(event.reason), ts };
  }
  if (event.type === "compaction_end") {
    if (event.errorMessage) return { kind: "tool-error", label: "COMPACT FAILED", detail: compactionEndDetail(event), ts };
    if (event.aborted) return { kind: "system", label: "COMPACT CANCELLED", detail: compactionEndDetail(event), ts };
    return { kind: "tool-done", label: "COMPACTED · context", detail: compactionEndDetail(event), ts };
  }
  if ((event.type === "message_end" || event.type === "message_update") && event.text) {
    return { kind: "reply", label: event.type === "message_update" ? "DRAFT" : "REPLY", detail: truncateText(event.text, 78), ts };
  }
  if ((event.type === "message_end" || event.type === "message_update") && event.thinking) {
    return { kind: "thinking", label: "THINKING", detail: truncateText(event.thinking, 78), ts };
  }
  if (event.type === "agent_reply") return { kind: "reply", label: "REPLY", detail: truncateText(event.text, 78), ts };
  if (event.type === "user_steer") return { kind: "reply", label: "STEER", detail: truncateText(event.text, 78), ts };
  if (event.type === "user_prompt") return { kind: "system", label: "USER PROMPT", detail: truncateText(event.text, 78), ts };
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
  let resultText: string | undefined;
  if (event.result !== undefined) {
    if (typeof event.result === "string") resultText = event.result;
    else {
      const r = event.result as Record<string, unknown>;
      if (Array.isArray(r?.content)) {
        resultText = (r.content as Array<Record<string, unknown>>).map((c) => String(c.text || "")).join(" ");
      } else if (r?.message) resultText = String(r.message);
      else if (r?.error) resultText = String(r.error);
    }
  }
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
    event.reason,
    event.errorMessage,
    event.text,
    event.thinking,
    resultText,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function isToolEvent(event: AgentEvent): boolean {
  return event.type === "tool_start" || event.type === "tool_end";
}

export function isCompactionEvent(event: AgentEvent): boolean {
  return event.type === "compaction_start" || event.type === "compaction_end";
}

export function isReplyEvent(event: AgentEvent): boolean {
  // The Replies filter should only surface events with actual reply content —
  // a message_end from a pure tool-call round (no text, no thinking) carries
  // nothing, so it's excluded here; the All stream hides it too (fish 2026-08-09).
  // user_steer is user-input family (with user_prompt), not a reply — All only.
  if (event.type === "message_end") return Boolean(event.text || event.thinking);
  return event.type === "agent_reply";
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
