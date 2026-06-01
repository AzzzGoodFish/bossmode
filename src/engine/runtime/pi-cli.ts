// Pi CLI Runtime — spawn pi --mode rpc, event mapping, extension generation
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger, formatSpawnArgs } from "../../foundation/logger.js";
import { getPiSpawnEnv } from "./env.js";
import { exportPiConfigForMember } from "../model-credentials.js";
import { BaseCliAgentHandle } from "./base-cli-handle.js";
import { buildChatToolDescription } from "../../shared/chat-tool-description.js";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  GET_TASK_DESCRIPTION,
  COMMENT_TASK_DESCRIPTION,
  QUERY_INTEGRATION_DESCRIPTION,
  CONFIGURE_INTEGRATION_DESCRIPTION,
  WRITE_SUMMARY_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../shared/mcp-tool-descriptions.js";
import type {
  AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts,
  RuntimeCapabilities, RuntimeDetectResult, TokenUsage, ContextUsage,
} from "./types.js";

// ============================================================================
// Extension Template
// ============================================================================

function generateExtension(serverUrl: string, roomId: string, agentName: string, roomMembers: string[]): string {
  const memberList = roomMembers.filter((m) => m !== agentName).join(", ");
  const chatDescription = JSON.stringify(buildChatToolDescription(memberList));
  return `
import { Type } from "@sinclair/typebox";

const QUERY_ROOM_MESSAGES_DESCRIPTION = ${JSON.stringify(QUERY_ROOM_MESSAGES_DESCRIPTION)};
const CREATE_TASK_DESCRIPTION = ${JSON.stringify(CREATE_TASK_DESCRIPTION)};
const UPDATE_TASK_DESCRIPTION = ${JSON.stringify(UPDATE_TASK_DESCRIPTION)};
const LIST_TASKS_DESCRIPTION = ${JSON.stringify(LIST_TASKS_DESCRIPTION)};
const GET_TASK_DESCRIPTION = ${JSON.stringify(GET_TASK_DESCRIPTION)};
const COMMENT_TASK_DESCRIPTION = ${JSON.stringify(COMMENT_TASK_DESCRIPTION)};
const QUERY_INTEGRATION_DESCRIPTION = ${JSON.stringify(QUERY_INTEGRATION_DESCRIPTION)};
const CONFIGURE_INTEGRATION_DESCRIPTION = ${JSON.stringify(CONFIGURE_INTEGRATION_DESCRIPTION)};
const WRITE_SUMMARY_DESCRIPTION = ${JSON.stringify(WRITE_SUMMARY_DESCRIPTION)};
const PARAM_DESCRIPTIONS = ${JSON.stringify(PARAM_DESCRIPTIONS)};

export default function (pi) {
  const SERVER = ${JSON.stringify(serverUrl)};
  const ROOM = ${JSON.stringify(roomId)};
  const AGENT = ${JSON.stringify(agentName)};
  const MAX_RESULT_CHARS = 25000;
  function truncate(text) {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + "\\n\\n--- Result truncated (" + text.length + " chars). Use a more specific query. ---";
  }

  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: ${chatDescription},
    parameters: Type.Object({
      message: Type.String({ description: "Message to post" }),
      target: Type.Optional(Type.String({ description: "'room' or 'user'; default follows triggering envelope footer" })),
      attachments: Type.Optional(Type.Array(Type.String(), { description: "Local file paths to attach. Files are copied to the room's attachment store. Recipients can preview/download them." })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "chat", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json().catch(() => ({}));
      const targetText = params.target === "user" ? "Private reply sent." : "Message sent to room.";
      const warningText = typeof data.warning === "string" && data.warning.length > 0
        ? " Warning: " + data.warning
        : "";
      return { content: [{ type: "text", text: targetText + warningText }], details: {} };
    },
  });

  pi.registerTool({
    name: "query_room_messages",
    label: "Query Room Messages",
    description: QUERY_ROOM_MESSAGES_DESCRIPTION,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.query })),
      from: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.from })),
      after: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.after })),
      before: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.before })),
      limit: Type.Optional(Type.Number({ description: PARAM_DESCRIPTIONS.limit })),
      output: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.output })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "query_room_messages", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      // File output mode: return path
      if (data && typeof data === "object" && "path" in data) {
        return { content: [{ type: "text", text: "Messages written to: " + data.path + " (count: " + data.count + ")" }], details: {} };
      }
      const messages = Array.isArray(data) ? data : [];
      const text = messages.length === 0
        ? "No messages found."
        : messages.map(m => "[" + m.sender + "]: " + m.content).join("\\n\\n");
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  });

  pi.registerTool({
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
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "create_task", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Task created: " + data.taskId + " \u2014 " + data.title }], details: {} };
    },
  });

  pi.registerTool({
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
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "update_task", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Task updated: " + data.taskId + " \u2014 status: " + data.status }], details: {} };
    },
  });

  pi.registerTool({
    name: "list_tasks",
    label: "List Tasks",
    description: LIST_TASKS_DESCRIPTION,
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskStatusFilter })),
      assignee: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.taskAssigneeFilter })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "list_tasks", room: ROOM, agent: AGENT, params }),
      });
      const tasks = await res.json();
      if (!Array.isArray(tasks)) return { content: [{ type: "text", text: "Failed to load tasks." }], details: {} };
      if (tasks.length === 0) return { content: [{ type: "text", text: "No tasks found." }], details: {} };
      const text = tasks.map(t => "[" + t.status + "] " + t.priority + " " + t.title + (t.assignee ? " (@" + t.assignee + ")" : "") + (t.commentCount ? " comments:" + t.commentCount : "") + " id:" + t.id).join("\\n");
      return { content: [{ type: "text", text: text }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_task",
    label: "Get Task",
    description: GET_TASK_DESCRIPTION,
    parameters: Type.Object({
      taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "get_task", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (data && data.ok === false) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: typeof data === "string" ? truncate(data) : truncate(JSON.stringify(data, null, 2)) }], details: {} };
    },
  });

  pi.registerTool({
    name: "comment_task",
    label: "Comment Task",
    description: COMMENT_TASK_DESCRIPTION,
    parameters: Type.Object({
      taskId: Type.String({ description: PARAM_DESCRIPTIONS.taskId }),
      comment: Type.String({ description: PARAM_DESCRIPTIONS.taskComment }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "comment_task", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Comment added: " + data.commentId + " on " + data.taskId }], details: {} };
    },
  });

  pi.registerTool({
    name: "query_integration",
    label: "Query Integration",
    description: QUERY_INTEGRATION_DESCRIPTION,
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationProvider })),
      team: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationTeam })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "query_integration", room: ROOM, agent: AGENT, params }),
      });
      return { content: [{ type: "text", text: truncate(JSON.stringify(await res.json(), null, 2)) }], details: {} };
    },
  });

  pi.registerTool({
    name: "configure_integration",
    label: "Configure Integration",
    description: CONFIGURE_INTEGRATION_DESCRIPTION,
    parameters: Type.Object({
      provider: Type.String({ description: PARAM_DESCRIPTIONS.integrationProvider }),
      team: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationTeam })),
      project: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.integrationProject })),
      enabled: Type.Optional(Type.Boolean({ description: PARAM_DESCRIPTIONS.integrationEnabled })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "configure_integration", room: ROOM, agent: AGENT, params }),
      });
      return { content: [{ type: "text", text: truncate(JSON.stringify(await res.json(), null, 2)) }], details: {} };
    },
  });

  pi.registerTool({
    name: "write_summary",
    label: "Write Summary",
    description: WRITE_SUMMARY_DESCRIPTION,
    parameters: Type.Object({
      title: Type.String({ description: PARAM_DESCRIPTIONS.summaryTitle }),
      summary: Type.String({ description: PARAM_DESCRIPTIONS.summary }),
      from_id: Type.String({ description: PARAM_DESCRIPTIONS.summaryFromId }),
      to_id: Type.String({ description: PARAM_DESCRIPTIONS.summaryToId }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "write_summary", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Summary created: \\"" + params.title + "\\" (" + data.coveredCount + " messages)" }], details: {} };
    },
  });
}
`;
}

// ============================================================================
// Event Mapping
// ============================================================================

function mapPiEvent(raw: any): AgentStreamEvent | null {
  switch (raw.type) {
    case "agent_start":
      return { type: "agent_start" };

    case "agent_end":
      return { type: "agent_end" };

    case "message_start":
      if (raw.message?.role === "assistant") return { type: "message_start" };
      return null;

    case "message_update": {
      const evt = raw.assistantMessageEvent;
      if (!evt) return null;
      if (evt.type === "text_delta" && evt.delta) {
        return { type: "message_update", text: evt.delta };
      }
      if (evt.type === "thinking_delta" && evt.delta) {
        return { type: "message_update", thinking: evt.delta };
      }
      return null;
    }

    case "message_end": {
      const msg = raw.message;
      if (msg?.role !== "assistant") return null;
      const text = msg.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
      const usage: TokenUsage | undefined = msg.usage ? {
        inputTokens: msg.usage.input || 0,
        outputTokens: msg.usage.output || 0,
        cacheRead: msg.usage.cacheRead,
        cacheWrite: msg.usage.cacheWrite,
        cost: msg.usage.cost?.total,
      } : undefined;
      const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : (typeof msg.stop_reason === "string" ? msg.stop_reason : undefined);
      const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error_message === "string" ? msg.error_message : undefined);
      return {
        type: "message_end",
        text,
        usage,
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };
    }

    case "tool_execution_start":
      return { type: "tool_start", toolName: raw.toolName, toolCallId: raw.toolCallId, args: raw.args };

    case "tool_execution_update":
      return { type: "tool_update", toolName: raw.toolName, toolCallId: raw.toolCallId, partialResult: raw.partialResult };

    case "tool_execution_end":
      return { type: "tool_end", toolName: raw.toolName, toolCallId: raw.toolCallId, result: raw.result, isError: raw.isError };

    default:
      return null;
  }
}

// ============================================================================
// PiCliAgentHandle
// ============================================================================

class PiCliAgentHandle extends BaseCliAgentHandle implements AgentHandle {
  readonly runtimeName = "pi-cli";

  constructor(proc: ChildProcessWithoutNullStreams, spawnArgs?: string[], initialStderr?: string) {
    super(proc, { spawnArgs, initialStderr });
  }

  protected get logScope(): string {
    return "runtime:pi-cli";
  }

  protected get runtimeDisplayName(): string {
    return "Pi CLI";
  }

  async prompt(message: string): Promise<void> {
    if (message === "/compact") {
      return this.handleCompactCommand();
    }
    return this.startWork({ type: "prompt", message });
  }

  steer(message: string): void {
    if (message === "/compact") {
      this.handleCompactCommand().catch((err) => {
        logger.error("runtime:pi-cli", "compact failed in steer", { error: err.message });
      });
      return;
    }
    this.safeStdinWrite(JSON.stringify({ type: "steer", message }) + "\n");
  }

  abort(): void {
    this.safeStdinWrite(JSON.stringify({ type: "abort" }) + "\n");
  }

  setModel(model: string): void {
    const parts = model.split("/");
    const cmd = parts.length >= 2
      ? { type: "set_model", provider: parts[0], modelId: parts.slice(1).join("/") }
      : { type: "set_model", provider: "anthropic", modelId: model };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  setThinkingLevel(level: string): void {
    this.safeStdinWrite(JSON.stringify({ type: "set_thinking_level", level }) + "\n");
  }

  querySessionState(): void {
    this.safeStdinWrite(JSON.stringify({ type: "get_state" }) + "\n");
  }

  private sessionCallback: ((session: { sessionId?: string; sessionFile?: string }) => void) | null = null;

  onSessionInfo(cb: (session: { sessionId?: string; sessionFile?: string }) => void): void {
    this.sessionCallback = cb;
  }

  protected handleParsedLine(raw: any): void {
    if (raw.type === "response" && raw.id) {
      if (this.resolveRequest(raw.id, !!raw.success, raw.data, raw.error || `RPC ${raw.command} failed`)) {
        return;
      }
    }

    if (raw.type === "response" && raw.command === "get_state" && raw.success && raw.data) {
      const session = {
        sessionId: raw.data.sessionId,
        sessionFile: raw.data.sessionFile,
      };
      if (this.sessionCallback) {
        this.sessionCallback(session);
        this.sessionCallback = null;
      }
    }

    if (raw.type === "compaction_start") {
      this.emit({ type: "agent_start" });
      return;
    }

    if (raw.type === "compaction_end") {
      const hasError = raw.error || raw.message || raw.reason || raw.summary === "error";
      if (hasError && typeof hasError === "string") {
        this.emit({ type: "message_end", text: `Context compaction failed: ${hasError}` });
      } else {
        const summary = ((raw.data?.summary ?? raw.summary ?? "No summary") as string).slice(0, 300);
        const tokensBefore = raw.data?.tokensBefore ?? raw.tokensBefore ?? "unknown";
        this.emit({ type: "message_end", text: `Context compacted.\nTokens before: ${tokensBefore}\nSummary: ${summary}` });
      }
      this.emit({ type: "agent_end" });
      return;
    }

    if (raw.type === "response" && raw.command === "compact") {
      if (raw.success) {
        const tokensBefore = raw.data?.tokensBefore ?? "unknown";
        const summary = (raw.data?.summary ?? "No summary").slice(0, 300);
        this.emit({ type: "message_end", text: `Context compacted.\nTokens before: ${tokensBefore}\nSummary: ${summary}` });
      } else {
        this.emit({ type: "message_end", text: `Compaction failed: ${raw.error || "unknown error"}` });
      }
      this.endWork();
      this.emit({ type: "agent_end" });
      return;
    }

    if (raw.type === "response" && raw.command === "prompt" && !raw.success) {
      const errorMsg = raw.error || "prompt failed";
      logger.error("runtime:pi-cli", "prompt RPC failed", { error: errorMsg });
      this.failWork(errorMsg);
      return;
    }

    if (raw.type === "agent_start") {
      this._isWorking = true;
      this._hasRuntimeStarted = true;
    }
    if (raw.type === "agent_end") {
      this.endWork();
    }

    const mapped = mapPiEvent(raw);
    if (mapped) this.emit(mapped);
  }

  protected buildRequestPayload(id: string, type: string, params?: Record<string, unknown>): unknown {
    return { type, id, ...(params || {}) };
  }

  emitPublic(event: AgentStreamEvent): void {
    this.emit(event);
  }

  appendStderrPublic(text: string): void {
    this.appendStderr(text);
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    try {
      const stats = await this.sendRequest("get_session_stats", {}, 10000, "RPC");
      const cu = stats?.contextUsage;
      if (!cu) return null;
      return {
        totalTokens: cu.tokens ?? 0,
        rawMaxTokens: cu.contextWindow ?? 0,
        percentage: cu.percent ?? 0,
        model: stats?.model?.id ?? "unknown",
      };
    } catch (err) {
      logger.warn("runtime:pi-cli", "getContextUsage failed", { pid: this.pid, error: String(err) });
      return null;
    }
  }

  private handleCompactCommand(): Promise<void> {
    this._isWorking = true;
    this._hasRuntimeStarted = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start" });
    this.emit({ type: "message_update", text: "Compacting context..." });
    this.resetActivityTimer();
    this.sendCommand({ type: "compact" });
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }
}

// ============================================================================
// Model normalization — short aliases → full Anthropic model IDs
// ============================================================================

function normalizeModel(model: string): string {
  const aliases: Record<string, string> = {
    "sonnet": "anthropic/claude-sonnet-4-6",
    "haiku": "anthropic/claude-haiku-4-5",
    "opus": "anthropic/claude-opus-4-6",
  };
  return aliases[model.toLowerCase()] || model;
}

// ============================================================================
// PiCliRuntime
// ============================================================================

export class PiCliRuntime implements AgentRuntime {
  readonly name = "pi-cli";
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    thinking: true,
    usage: true,
    dynamicModel: true,
    dynamicThinking: true,
    permissionControl: false,
    sessionResume: true,
    contextUsage: true,
  };

  private cliPath: string;
  private handles: PiCliAgentHandle[] = [];
  private extFiles: string[] = [];
  private serverPort: number;

  constructor(cliPath?: string, serverPort: number = 8080) {
    this.cliPath = cliPath || "pi";
    this.serverPort = serverPort;
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const path = this.cliPath === "pi"
        ? execSync("which pi", { encoding: "utf-8" }).trim()
        : this.cliPath;
      const version = execSync(`${this.cliPath} --version 2>&1`, { encoding: "utf-8" }).trim();
      return { available: true, version, path };
    } catch (err: any) {
      return { available: false, error: err.message };
    }
  }

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;

    // Generate extension file
    const extPath = `/tmp/bossmode-ext-${opts.roomId.slice(0, 8)}-${opts.member.name}.ts`;
    const extContent = generateExtension(serverUrl, opts.roomId, opts.member.name, opts.roomMembers);
    writeFileSync(extPath, extContent, "utf-8");
    this.extFiles.push(extPath);

    const resolvedModel = normalizeModel(opts.member.model || "claude-sonnet-4-6");
    const piConfig = exportPiConfigForMember({
      roomId: opts.roomId,
      memberName: opts.member.name,
      modelRef: resolvedModel,
      credentialId: opts.member.credentialId,
    });

    // --system-prompt replaces pi's default prompt; use it only for the agent's own role prompt.
    // Bossmode overlays (env/docs/rules) are always appended so builtin/general can preserve pi defaults.
    const rolePrompt = opts.agentPrompt.trim();

    const buildArgs = (sessionFile?: string): string[] => {
      const args = [
        "--mode", "rpc",
        "--model", resolvedModel,
        "--thinking", opts.member.thinkingLevel || "off",
        "--no-skills",
        "--extension", extPath,
        ...(piConfig?.extensionPaths || []).flatMap((p) => ["--extension", p]),
        ...opts.skillPaths.filter((p) => existsSync(p)).flatMap((p) => ["--skill", p]),
      ];

      if (rolePrompt) args.push("--system-prompt", rolePrompt);
      if (opts.envPrompt.trim()) args.push("--append-system-prompt", opts.envPrompt);

      if (sessionFile) args.push("--session", sessionFile);
      if (opts.rulesPrompt) args.push("--append-system-prompt", opts.rulesPrompt);
      return args;
    };

    const doSpawn = async (args: string[]): Promise<PiCliAgentHandle> => {
      logger.info("runtime:pi-cli", "createAgent", {
        agent: opts.member.name, model: resolvedModel,
        thinking: opts.member.thinkingLevel || "off",
        skills: opts.skillPaths.length, cwd: opts.cwd,
      });

      const proc = spawn(this.cliPath, args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: getPiSpawnEnv(piConfig?.agentDir),
      });

      const spawnHeader = `spawn agent="${opts.member.name}" pid=${proc.pid}`;
      console.log(`[${new Date().toISOString()}] INFO [runtime:pi-cli] ${spawnHeader}\n${formatSpawnArgs(this.cliPath, args)}`);

      let stderrBuf = "";
      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
      });

      proc.on("exit", (code, signal) => {
        logger.info("runtime:pi-cli", "process exit", { agent: opts.member.name, code, signal, stderr: stderrBuf.slice(0, 500) || undefined });
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 500);
        proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
        proc.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout);
            // Wait a tick so any final stderr chunk is flushed into stderrBuf.
            setImmediate(() => {
              const tail = stderrBuf.trim().slice(-800);
              const detail = tail ? `: ${tail}` : "";
              reject(new Error(`pi process exited with code ${code}${detail}`));
            });
          }
        });
      });

      const handle = new PiCliAgentHandle(proc, [this.cliPath, ...args], stderrBuf);

      // Emit raw stderr for debugging (after handle creation so listeners exist)
      // and also feed handle's stderrTail so runtime_exit carries it.
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        handle.appendStderrPublic(text);
        if (text.trim()) handle.emitPublic({ type: "cli:stderr", text });
      });

      return handle;
    };

    // Try with session resume, fallback to fresh
    let handle: PiCliAgentHandle;
    const sessionFile = opts.resumeSession?.sessionFile;
    if (sessionFile) {
      try {
        handle = await doSpawn(buildArgs(sessionFile));
        logger.info("runtime:pi-cli", "session resumed", { agent: opts.member.name, sessionFile });
      } catch (err: any) {
        logger.warn("runtime:pi-cli", "session resume failed, starting fresh", { agent: opts.member.name, error: err.message });
        handle = await doSpawn(buildArgs());
      }
    } else {
      handle = await doSpawn(buildArgs());
    }

    // Query session state and notify caller
    if (opts.onSessionChanged) {
      handle.onSessionInfo((session) => {
        opts.onSessionChanged!(session);
      });
      handle.querySessionState();
    }

    this.handles.push(handle);
    return handle;
  }

  async shutdownAll(): Promise<void> {
    for (const handle of this.handles) {
      handle.abort();
      await Promise.race([
        handle.waitForIdle(),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
      handle.destroy();
    }
    this.handles = [];

    // Clean up extension files
    for (const f of this.extFiles) {
      try { unlinkSync(f); } catch {}
    }
    this.extFiles = [];
  }
}
