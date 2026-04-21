// Pi CLI Runtime — spawn pi --mode rpc, event mapping, extension generation
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger, formatSpawnArgs } from "../../foundation/logger.js";
import { getCleanSpawnEnv } from "./env.js";
import { buildChatToolDescription } from "../../shared/chat-tool-description.js";
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
      mentions: Type.Optional(Type.Array(Type.String(), { description: "Agent names to activate (authoritative activation channel)" })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "chat", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json().catch(() => ({}));
      const targetText = params.target === "user" ? "Private reply sent." : "Message sent to room.";
      const explicit = Array.isArray(params.mentions) ? params.mentions : [];
      const mentionText = explicit.length ? " Mentioned: " + explicit.join(", ") : "";
      const warningText = typeof data.warning === "string" && data.warning.length > 0
        ? " Warning: " + data.warning
        : "";
      return { content: [{ type: "text", text: targetText + mentionText + warningText }], details: {} };
    },
  });

  pi.registerTool({
    name: "query_room_messages",
    label: "Query Room Messages",
    description: "Read recent messages from the group chat room to understand the conversation context.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Number of messages to retrieve (default 50)" })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "query_room_messages", room: ROOM, agent: AGENT, params }),
      });
      const messages = await res.json();
      const text = messages.length === 0
        ? "No messages in room."
        : messages.map(m => "[" + m.sender + "]: " + m.content).join("\\n\\n");
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  });

  pi.registerTool({
    name: "save_knowledge",
    label: "Save Knowledge",
    description: "Create a new project document (Markdown file). Path is a POSIX-style path relative to the docs root (e.g. 'architecture/overview.md' or 'prds/smart-summary.md'). If path is omitted, the document is placed under 'misc/'. A .md extension is appended if missing.",
    parameters: Type.Object({
      title: Type.String({ description: "Human-readable document title" }),
      content: Type.String({ description: "Markdown body (frontmatter is generated automatically)" }),
      path: Type.Optional(Type.String({ description: "Target path, e.g. 'architecture/overview.md'. Required unless you are fine with auto-placement under misc/." })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "save_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + (data.error || "unknown error") }], details: {} };
      return { content: [{ type: "text", text: "Document saved at " + data.path + ": " + (data.title || params.title) }], details: {} };
    },
  });

  pi.registerTool({
    name: "query_knowledge",
    label: "Query Knowledge",
    description: "Explore or search the project document library. Without a query, returns the directory tree plus a summary list (titles + paths, no content). With a query, returns full content of documents whose title or body contains the query substring (case-insensitive).",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search substring. Omit to get the full tree + summaries." })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "query_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      // Filtered-search returns an array of {id, title, content, ...}
      if (Array.isArray(data)) {
        if (data.length === 0) return { content: [{ type: "text", text: "No documents matched." }], details: {} };
        const text = data.map(e => "## " + e.title + " (" + e.id + ")\\n" + (e.content || "")).join("\\n---\\n");
        return { content: [{ type: "text", text: truncate(text) }], details: {} };
      }
      // Tree form
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (entries.length === 0) return { content: [{ type: "text", text: "Project document library is empty." }], details: {} };
      const lines = ["Documents:"];
      for (const e of entries) lines.push("- " + e.path + "  \u2014  " + e.title);
      lines.push("", "Use read_knowledge(path) to read a specific document, or query_knowledge(query) to search.");
      return { content: [{ type: "text", text: truncate(lines.join("\\n")) }], details: {} };
    },
  });

  pi.registerTool({
    name: "read_knowledge",
    label: "Read Knowledge",
    description: "Read the full content of a specific document by its path (e.g. 'architecture/overview.md'). Use query_knowledge first to discover available paths.",
    parameters: Type.Object({
      path: Type.String({ description: "Document path relative to the docs root" }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "read_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + (data.error || "unknown error") }], details: {} };
      const text = "# " + data.title + "\\n\\n" + data.content;
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  });

  pi.registerTool({
    name: "update_knowledge",
    label: "Update Knowledge",
    description: "Overwrite an existing document's title and content.",
    parameters: Type.Object({
      path: Type.String({ description: "Document path (e.g. 'architecture/overview.md')" }),
      title: Type.String({ description: "New title" }),
      content: Type.String({ description: "New markdown body" }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "update_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Document updated at " + data.path }], details: {} };
    },
  });

  pi.registerTool({
    name: "delete_knowledge",
    label: "Delete Knowledge",
    description: "Delete a document by its path.",
    parameters: Type.Object({
      path: Type.String({ description: "Document path to delete (e.g. 'misc/obsolete-notes.md')" }),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "delete_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const data = await res.json();
      if (!data.ok) return { content: [{ type: "text", text: "Failed: " + data.error }], details: {} };
      return { content: [{ type: "text", text: "Document deleted." }], details: {} };
    },
  });

  pi.registerTool({
    name: "write_summary",
    label: "Write Summary",
    description: "Create a topic-based summary message that covers a range of messages. Only callable by the summarizer agent.",
    parameters: Type.Object({
      title: Type.String({ description: "Short topic title for this summary segment" }),
      summary: Type.String({ description: "1-3 sentence summary of the key content, decisions, and conclusions" }),
      from_id: Type.String({ description: "Message ID of the first message in this segment" }),
      to_id: Type.String({ description: "Message ID of the last message in this segment" }),
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
      return { type: "message_end", text, usage };
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

const STDERR_TAIL_MAX = 1024;

class PiCliAgentHandle implements AgentHandle {
  private proc: ChildProcessWithoutNullStreams;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private _isWorking = false;
  private idleResolvers: Array<() => void> = [];
  private promptRejecter: ((err: Error) => void) | null = null;
  private buffer = "";
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private destroyed = false;
  private exitEmitted = false;
  private stderrTail = "";

  readonly pid: number | undefined;
  readonly runtimeName = "pi-cli";
  readonly spawnArgs: string[];

  constructor(proc: ChildProcessWithoutNullStreams, spawnArgs?: string[], initialStderr?: string) {
    this.proc = proc;
    this.pid = proc.pid;
    this.spawnArgs = spawnArgs || [];
    if (initialStderr) this.appendStderr(initialStderr);

    // Parse stdout JSONL
    proc.stdout.on("data", (data: Buffer) => {
      this.resetActivityTimer();
      const text = data.toString();
      // Emit raw stdout for debugging
      this.emit({ type: "cli:stdout", text });
      this.buffer += text;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          this.handleRawEvent(raw);
        } catch { /* skip non-JSON */ }
      }
    });

    // Handle process errors
    proc.on("error", (err) => {
      logger.error("runtime:pi-cli", "process error", { pid: this.pid, error: err.message });
      if (this._isWorking) {
        this._isWorking = false;
        this.emit({ type: "agent_end" });
      }
      if (this.promptRejecter) {
        this.promptRejecter(new Error(`Pi CLI process error: ${err.message}`));
        this.promptRejecter = null;
      }
      this.resolveIdle();
    });

    proc.stdin.on("error", (err) => {
      logger.error("runtime:pi-cli", "stdin error", { pid: this.pid, error: err.message });
    });

    // Handle process exit
    proc.on("exit", (code, signal) => {
      this.clearActivityTimer();
      if (this._isWorking) {
        this._isWorking = false;
        this.emit({ type: "agent_end" });
      }
      this.emitRuntimeExit(code, signal);
      this.resolveIdle();
    });
  }

  private appendStderr(text: string): void {
    if (!text) return;
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX);
  }

  private emitRuntimeExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    const tail = this.stderrTail.trim();
    this.emit({
      type: "runtime_exit",
      code,
      signal: signal || null,
      stderrTail: tail ? tail : undefined,
      unexpected: !this.destroyed,
    });
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  async prompt(message: string): Promise<void> {
    // Intercept /compact — translate to RPC compact command
    if (message === "/compact") {
      return this.handleCompactCommand();
    }
    const cmd = { type: "prompt", message };
    this._isWorking = true;
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
    this.resetActivityTimer();
    // Wait for agent_end or RPC error response
    return new Promise<void>((resolve, reject) => {
      this.idleResolvers.push(resolve);
      this.promptRejecter = reject;
    });
  }

  steer(message: string): void {
    // Intercept /compact — translate to RPC compact command
    if (message === "/compact") {
      this.handleCompactCommand().catch((err) => {
        logger.error("runtime:pi-cli", "compact failed in steer", { error: err.message });
      });
      return;
    }
    const cmd = { type: "steer", message };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  abort(): void {
    const cmd = { type: "abort" };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  waitForIdle(): Promise<void> {
    if (!this._isWorking) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setModel(model: string): void {
    // Parse "provider/modelId" format
    const parts = model.split("/");
    const cmd = parts.length >= 2
      ? { type: "set_model", provider: parts[0], modelId: parts.slice(1).join("/") }
      : { type: "set_model", provider: "anthropic", modelId: model };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  setThinkingLevel(level: string): void {
    const cmd = { type: "set_thinking_level", level };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  destroy(): void {
    this.destroyed = true;
    this.clearActivityTimer();
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent destroyed"));
    }
    this.pendingRequests.clear();
    try { this.proc.kill(); } catch {}
    this.listeners.clear();
    this.resolveIdle();
  }

  // Query session state from pi RPC
  querySessionState(): void {
    const cmd = { type: "get_state" };
    this.safeStdinWrite(JSON.stringify(cmd) + "\n");
  }

  private sessionCallback: ((session: { sessionId?: string; sessionFile?: string }) => void) | null = null;

  onSessionInfo(cb: (session: { sessionId?: string; sessionFile?: string }) => void): void {
    this.sessionCallback = cb;
  }

  private handleRawEvent(raw: any): void {
    // Generic RPC response routing — match pending requests by id
    if (raw.type === "response" && raw.id && this.pendingRequests.has(raw.id)) {
      const pending = this.pendingRequests.get(raw.id)!;
      this.pendingRequests.delete(raw.id);
      clearTimeout(pending.timer);
      if (raw.success) {
        pending.resolve(raw.data ?? {});
      } else {
        pending.reject(new Error(raw.error || `RPC ${raw.command} failed`));
      }
      return;
    }

    // get_state response — extract session info
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

    // RPC error response — prompt failed (e.g. no API key, invalid model)
    if (raw.type === "response" && raw.command === "prompt" && !raw.success) {
      const errorMsg = raw.error || "prompt failed";
      logger.error("runtime:pi-cli", "prompt RPC failed", { error: errorMsg });
      this._isWorking = false;
      this.emit({ type: "agent_end" });
      if (this.promptRejecter) {
        this.promptRejecter(new Error(errorMsg));
        this.promptRejecter = null;
      }
      this.resolveIdle();
      return;
    }

    // Track working state
    if (raw.type === "agent_start") this._isWorking = true;
    if (raw.type === "agent_end") {
      this.clearActivityTimer();
      this._isWorking = false;
      this.promptRejecter = null; // Clear — succeeded
      this.resolveIdle();
    }

    const mapped = mapPiEvent(raw);
    if (mapped) this.emit(mapped);
  }

  /** Public emit for external callers (e.g. stderr handler wired after construction) */
  emitPublic(event: AgentStreamEvent): void {
    this.emit(event);
  }

  /** Append to the stderr tail captured for runtime_exit reporting. */
  appendStderrPublic(text: string): void {
    this.appendStderr(text);
  }

  private emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private resolveIdle(): void {
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
  }

  private resetActivityTimer(): void {
    this.clearActivityTimer();
    if (!this._isWorking) return;
    this.activityTimer = setTimeout(() => {
      logger.error("runtime:pi-cli", "activity timeout", { timeoutMs: 90000, pid: this.proc.pid });
      this._isWorking = false;
      this.emit({ type: "agent_end" });
      if (this.promptRejecter) {
        this.promptRejecter(new Error("Pi CLI activity timeout (90s no output)"));
        this.promptRejecter = null;
      }
      this.resolveIdle();
    }, 90000);
  }

  private clearActivityTimer(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  // -- RPC request/response matching --

  private sendRpcCommand(type: string, params?: Record<string, unknown>, timeoutMs = 10000): Promise<any> {
    const id = Math.random().toString(36).substring(2, 15);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC "${type}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.safeStdinWrite(JSON.stringify({ type, id, ...params }) + "\n");
    });
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    try {
      const stats = await this.sendRpcCommand("get_session_stats", {}, 5000);
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

  private async handleCompactCommand(): Promise<void> {
    this._isWorking = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start" });

    try {
      const result = await this.sendRpcCommand("compact", {}, 30000);
      const tokensBefore = result?.tokensBefore ?? "unknown";
      const summary = (result?.summary ?? "No summary").slice(0, 300);
      this.emit({ type: "message_end", text: `Context compacted.\nTokens before: ${tokensBefore}\nSummary: ${summary}` });
    } catch (err: any) {
      this.emit({ type: "message_end", text: `Compaction failed: ${err.message}` });
    }

    this._isWorking = false;
    this.emit({ type: "agent_end" });
    this.resolveIdle();
  }

  private safeStdinWrite(data: string): void {
    try {
      if (this.proc.stdin.writable && !this.proc.killed) {
        this.proc.stdin.write(data);
      } else {
        logger.error("runtime:pi-cli", "stdin not writable", { pid: this.pid, killed: this.proc.killed });
      }
    } catch (err: any) {
      logger.error("runtime:pi-cli", "stdin write failed", { pid: this.pid, error: err.message });
    }
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

    const resolvedModel = normalizeModel(opts.member.model);

    // Decide injection strategy based on whether agentPrompt has content
    const hasAgentPrompt = opts.agentPrompt.trim().length > 0;

    const buildArgs = (sessionFile?: string): string[] => {
      const args = [
        "--mode", "rpc",
        "--model", resolvedModel,
        "--thinking", opts.member.thinkingLevel || "off",
        "--no-skills",
        "--extension", extPath,
        ...opts.skillPaths.filter((p) => existsSync(p)).flatMap((p) => ["--skill", p]),
      ];

      if (hasAgentPrompt) {
        // Override mode: agentPrompt + envPrompt in --system-prompt
        args.push("--system-prompt", opts.agentPrompt + "\n" + opts.envPrompt);
      } else {
        // Append mode: preserve CLI default, append envPrompt
        args.push("--append-system-prompt", opts.envPrompt);
      }

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
        env: getCleanSpawnEnv(),
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
      if (handle.isWorking) {
        handle.abort();
        await Promise.race([
          handle.waitForIdle(),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]);
      }
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
