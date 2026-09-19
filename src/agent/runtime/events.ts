import type { AgentStreamEvent, ContextUsage, TokenUsage } from "../types.js";
function textFromMessage(msg: any): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => typeof c === "string" || c?.type === "text" || typeof c?.text === "string")
    .map((c: any) => typeof c === "string" ? c : c.text || "")
    .join("");
}
export function mapPiAgentEvent(raw: any): AgentStreamEvent | null {
  switch (raw?.type) {
    case "agent_start": return { type: "agent_start" };
    case "agent_end": return { type: "agent_end", willRetry: !!raw.willRetry };
    case "message_start":
      return raw.message?.role === "assistant" ? { type: "message_start" } : null;
    case "message_update": {
      const evt = raw.assistantMessageEvent;
      if (!evt) return null;
      if (evt.type === "text_delta" && evt.delta) return { type: "message_update", text: evt.delta };
      if (evt.type === "thinking_delta" && evt.delta) return { type: "message_update", thinking: evt.delta };
      return null;
    }
    case "message_end": {
      const msg = raw.message;
      if (msg?.role !== "assistant") return null;
      const usage: TokenUsage | undefined = msg.usage ? {
        inputTokens: msg.usage.input || msg.usage.inputTokens || 0,
        outputTokens: msg.usage.output || msg.usage.outputTokens || 0,
        cacheRead: msg.usage.cacheRead,
        cacheWrite: msg.usage.cacheWrite,
        cost: typeof msg.usage.cost === "number" ? msg.usage.cost : msg.usage.cost?.total,
      } : undefined;
      const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : (typeof msg.stop_reason === "string" ? msg.stop_reason : undefined);
      const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error_message === "string" ? msg.error_message : undefined);
      return { type: "message_end", text: textFromMessage(msg), ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}), ...(errorMessage ? { errorMessage } : {}) };
    }
    case "tool_execution_start":
      return { type: "tool_start", toolName: raw.toolName, toolCallId: raw.toolCallId, args: raw.args };
    case "tool_execution_update":
      return { type: "tool_update", toolName: raw.toolName, toolCallId: raw.toolCallId, partialResult: raw.partialResult };
    case "tool_execution_end":
      return { type: "tool_end", toolName: raw.toolName, toolCallId: raw.toolCallId, result: raw.result, isError: !!raw.isError };
    case "compaction_start":
      return { type: "compaction_start", reason: raw.reason };
    case "compaction_end": {
      const tokensBefore = Number(raw.result?.tokensBefore);
      return {
        type: "compaction_end",
        reason: raw.reason,
        aborted: !!raw.aborted,
        willRetry: !!raw.willRetry,
        ...(typeof raw.errorMessage === "string" && raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
        ...(Number.isFinite(tokensBefore) ? { tokensBefore } : {}),
        ...(raw.result !== undefined ? { result: raw.result } : {}),
      };
    }
    default:
      return null;
  }
}
export function mapContextUsage(raw: any, modelLabel = "unknown"): ContextUsage | null {
  if (!raw) return null;
  const compacted = raw.tokens === null || raw.totalTokens === null || raw.total === null;
  const total = compacted ? 0 : (raw.tokens ?? raw.totalTokens ?? raw.total ?? 0);
  const max = raw.contextWindow ?? raw.rawMaxTokens ?? raw.maxTokens ?? 0;
  const pct = raw.percent ?? raw.percentage ?? (max > 0 ? (total / max) * 100 : 0);
  return { totalTokens: total, rawMaxTokens: max, percentage: pct, model: raw.model?.id || raw.model || modelLabel, ...(compacted ? { compacted: true } : {}) };
}
