// Pi CLI Runtime — spawn pi --mode rpc, event mapping, extension generation
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger, formatSpawnArgs } from "../../foundation/logger.js";
import { getCleanSpawnEnv } from "./env.js";
import type {
  AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts,
  RuntimeCapabilities, RuntimeDetectResult, TokenUsage,
} from "./types.js";

// ============================================================================
// Extension Template
// ============================================================================

function generateExtension(serverUrl: string, roomId: string, agentName: string, roomMembers: string[]): string {
  const memberList = roomMembers.filter((m) => m !== agentName).join(", ");
  return `
import { Type } from "@sinclair/typebox";

export default function (pi) {
  const SERVER = ${JSON.stringify(serverUrl)};
  const ROOM = ${JSON.stringify(roomId)};
  const AGENT = ${JSON.stringify(agentName)};

  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: "Post a message. target='room' (default) sends to group chat visible to all. target='user' sends a private reply only the user sees. Optionally mention agents to activate them. Room members: ${memberList}",
    parameters: Type.Object({
      message: Type.String({ description: "Message to post" }),
      target: Type.Optional(Type.String({ description: "'room' (default, everyone sees) or 'user' (private reply)" })),
      mentions: Type.Optional(Type.Array(Type.String(), { description: "Agent names to mention and activate" })),
    }),
    async execute(id, params) {
      await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "chat", room: ROOM, agent: AGENT, params }),
      });
      const targetText = params.target === "user" ? "Private reply sent." : "Message sent to room.";
      const mentionText = params.mentions?.length ? " Mentioned: " + params.mentions.join(", ") : "";
      return { content: [{ type: "text", text: targetText + mentionText }], details: {} };
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
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "save_knowledge",
    label: "Save Knowledge",
    description: "Save knowledge to the project knowledge base.",
    parameters: Type.Object({
      title: Type.String({ description: "Title" }),
      content: Type.String({ description: "Content" }),
    }),
    async execute(id, params) {
      await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "save_knowledge", room: ROOM, agent: AGENT, params }),
      });
      return { content: [{ type: "text", text: "Knowledge saved: " + params.title }], details: {} };
    },
  });

  pi.registerTool({
    name: "query_knowledge",
    label: "Query Knowledge",
    description: "Query the project knowledge base.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query" })),
    }),
    async execute(id, params) {
      const res = await fetch(SERVER + "/internal/tool-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "query_knowledge", room: ROOM, agent: AGENT, params }),
      });
      const entries = await res.json();
      const text = entries.length === 0
        ? "No knowledge entries found."
        : entries.map(e => "## " + e.title + "\\n" + e.content).join("\\n---\\n");
      return { content: [{ type: "text", text }], details: {} };
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

class PiCliAgentHandle implements AgentHandle {
  private proc: ChildProcessWithoutNullStreams;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private _isWorking = false;
  private idleResolvers: Array<() => void> = [];
  private promptRejecter: ((err: Error) => void) | null = null;
  private buffer = "";

  readonly pid: number | undefined;
  readonly runtimeName = "pi-cli";
  readonly spawnArgs: string;

  constructor(proc: ChildProcessWithoutNullStreams, spawnArgs?: string) {
    this.proc = proc;
    this.pid = proc.pid;
    this.spawnArgs = spawnArgs || "";

    // Parse stdout JSONL
    proc.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
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

    // Handle process exit
    proc.on("exit", (code) => {
      if (this._isWorking) {
        this._isWorking = false;
        this.emit({ type: "agent_end" });
      }
      this.resolveIdle();
    });
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  async prompt(message: string): Promise<void> {
    const cmd = { type: "prompt", message };
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    // Wait for agent_end or RPC error response
    return new Promise<void>((resolve, reject) => {
      this.idleResolvers.push(resolve);
      this.promptRejecter = reject;
    });
  }

  steer(message: string): void {
    const cmd = { type: "steer", message };
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  abort(): void {
    const cmd = { type: "abort" };
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
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
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  setThinkingLevel(level: string): void {
    const cmd = { type: "set_thinking_level", level };
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  destroy(): void {
    try { this.proc.kill(); } catch {}
    this.listeners.clear();
    this.resolveIdle();
  }

  // Query session state from pi RPC
  querySessionState(): void {
    const cmd = { type: "get_state" };
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private sessionCallback: ((session: { sessionId?: string; sessionFile?: string }) => void) | null = null;

  onSessionInfo(cb: (session: { sessionId?: string; sessionFile?: string }) => void): void {
    this.sessionCallback = cb;
  }

  private handleRawEvent(raw: any): void {
    // get_state response — extract session info
    if (raw.type === "response" && raw.command === "get_state" && raw.success && raw.state) {
      const session = {
        sessionId: raw.state.sessionId,
        sessionFile: raw.state.sessionFile,
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
      this._isWorking = false;
      this.promptRejecter = null; // Clear — succeeded
      this.resolveIdle();
    }

    const mapped = mapPiEvent(raw);
    if (mapped) this.emit(mapped);
  }

  private emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private resolveIdle(): void {
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
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

    const buildArgs = (sessionFile?: string): string[] => {
      const args = [
        "--mode", "rpc",
        "--system-prompt", opts.agentPrompt,
        "--model", resolvedModel,
        "--thinking", opts.member.thinkingLevel || "off",
        "--no-extensions",
        "--no-skills",
        "--extension", extPath,
        ...opts.skillPaths.filter((p) => existsSync(p)).flatMap((p) => ["--skill", p]),
      ];
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
            reject(new Error(`pi process exited with code ${code}`));
          }
        });
      });

      return new PiCliAgentHandle(proc, `${this.cliPath} ${args.join(" ")}`);
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
    if (opts.onSessionCreated) {
      handle.onSessionInfo((session) => {
        opts.onSessionCreated!(session);
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
