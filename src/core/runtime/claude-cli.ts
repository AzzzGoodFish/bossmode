// Claude CLI Runtime — spawn claude --input-format stream-json, event mapping, MCP config
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { logger, formatSpawnArgs } from "../../foundation/logger.js";
import { getCleanSpawnEnv } from "./env.js";
import type {
  AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts,
  RuntimeCapabilities, RuntimeDetectResult, TokenUsage,
} from "./types.js";

// ============================================================================
// Thinking level → effort mapping
// ============================================================================

function mapThinkingToEffort(level: string): string {
  const map: Record<string, string> = {
    off: "low", minimal: "low", low: "low",
    medium: "medium", high: "high", xhigh: "max",
  };
  return map[level] || "medium";
}

// Map model IDs to Claude CLI aliases (full model IDs may not work with Claude Max)
function mapModelToAlias(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  // Return as-is if it's already an alias or unknown
  if (["opus", "sonnet", "haiku"].includes(m)) return m;
  return model; // Try as-is, may fail
}

// ============================================================================
// Event Mapping
// ============================================================================

function mapClaudeEvent(raw: any, state: ClaudeParseState): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  switch (raw.type) {
    case "system":
      // Init event — store session info, no mapped event
      state.sessionId = raw.session_id;
      state.initialized = true;
      break;

    case "assistant": {
      const msg = raw.message;
      if (!msg?.content) break;

      if (!state.inMessage) {
        events.push({ type: "message_start" });
        state.inMessage = true;
      }

      // Parse content blocks
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "message_update", text: block.text });
        }
        if (block.type === "thinking" && block.thinking) {
          events.push({ type: "message_update", thinking: block.thinking });
        }
        if (block.type === "tool_use") {
          state.toolNames.set(block.id, block.name);
          events.push({
            type: "tool_start",
            toolName: block.name,
            toolCallId: block.id,
            args: block.input,
          });
        }
      }

      // Extract usage
      if (msg.usage) {
        state.lastUsage = {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheRead: msg.usage.cache_read_input_tokens,
          cacheWrite: msg.usage.cache_creation_input_tokens,
        };
      }
      break;
    }

    case "user": {
      // Tool results
      const msg = raw.message;
      if (!msg?.content) break;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          let resultText = "";
          if (Array.isArray(block.content)) {
            resultText = block.content.map((c: any) => c.text || "").join("");
          } else if (typeof block.content === "string") {
            resultText = block.content;
          } else if (block.content != null) {
            resultText = JSON.stringify(block.content);
          }
          const toolName = state.toolNames.get(block.tool_use_id) || "";
          events.push({
            type: "tool_end",
            toolName,
            toolCallId: block.tool_use_id,
            result: resultText,
            isError: !!block.is_error,
          });
        }
      }
      break;
    }

    case "result": {
      // End of a turn
      if (state.inMessage) {
        const text = raw.result || "";
        events.push({ type: "message_end", text, usage: state.lastUsage });
        state.inMessage = false;
      }

      if (raw.total_cost_usd !== undefined && state.lastUsage) {
        state.lastUsage.cost = raw.total_cost_usd;
      }

      events.push({ type: "agent_end" });
      break;
    }
  }

  return events;
}

interface ClaudeParseState {
  sessionId?: string;
  initialized: boolean;
  inMessage: boolean;
  lastUsage?: TokenUsage;
  toolNames: Map<string, string>; // toolCallId → toolName
}

// ============================================================================
// ClaudeCliAgentHandle
// ============================================================================

class ClaudeCliAgentHandle implements AgentHandle {
  private proc: ChildProcessWithoutNullStreams;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private _isWorking = false;
  private idleResolvers: Array<() => void> = [];
  private promptRejecter: ((err: Error) => void) | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCallback: ((session: { sessionId?: string }) => void) | null = null;

  readonly pid: number | undefined;
  readonly runtimeName = "claude-cli";
  readonly spawnArgs: string;
  private buffer = "";
  private state: ClaudeParseState = { initialized: false, inMessage: false, toolNames: new Map() };

  constructor(proc: ChildProcessWithoutNullStreams, spawnArgs?: string) {
    this.proc = proc;
    this.pid = proc.pid;
    this.spawnArgs = spawnArgs || "";

    proc.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          this.handleRaw(raw);
        } catch { /* skip */ }
      }
    });

    proc.on("exit", (code) => {
      this.clearActivityTimer();
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
    // Don't wait for init — Claude needs stdin input before it initializes.
    // Send the message immediately; Claude will init then process it.
    this._isWorking = true;
    this.emit({ type: "agent_start" });

    const userMsg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    };
    this.proc.stdin.write(JSON.stringify(userMsg) + "\n");

    // Activity timeout: if no stdout output within 90s, reject
    return new Promise<void>((resolve, reject) => {
      this.idleResolvers.push(resolve);
      this.promptRejecter = reject;
      this.resetActivityTimer();
    });
  }

  steer(message: string): void {
    const userMsg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    };
    this.proc.stdin.write(JSON.stringify(userMsg) + "\n");
  }

  abort(): void {
    try { this.proc.kill("SIGTERM"); } catch {}
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

  onSessionInfo(cb: (session: { sessionId?: string }) => void): void {
    this.sessionCallback = cb;
  }

  destroy(): void {
    this.clearActivityTimer();
    try { this.proc.kill(); } catch {}
    this.listeners.clear();
    this.resolveIdle();
  }

  private handleRaw(raw: any): void {
    // DEBUG: log every raw JSON line from Claude stdout
    logger.info("runtime:claude-cli", "raw", { type: raw.type, subtype: raw.subtype, keys: Object.keys(raw) });

    // Any stdout activity resets the timeout
    this.resetActivityTimer();

    if (raw.type === "system" && !this.state.initialized) {
      this.state.initialized = true;
      this.state.sessionId = raw.session_id;
      logger.info("runtime:claude-cli", "init received", { sessionId: raw.session_id, pid: this.proc.pid });
      if (this.sessionCallback) {
        this.sessionCallback({ sessionId: raw.session_id });
        this.sessionCallback = null;
      }
    }

    const mapped = mapClaudeEvent(raw, this.state);
    for (const event of mapped) {
      if (event.type === "agent_end") {
        this._isWorking = false;
        this.promptRejecter = null;
        this.clearActivityTimer();
        this.resolveIdle();
      }
      this.emit(event);
    }
  }

  private resetActivityTimer(): void {
    this.clearActivityTimer();
    if (!this._isWorking) return;
    this.activityTimer = setTimeout(() => {
      logger.error("runtime:claude-cli", "activity timeout", { timeoutMs: 90000, pid: this.proc.pid });
      this._isWorking = false;
      this.emit({ type: "agent_end" });
      if (this.promptRejecter) {
        this.promptRejecter(new Error("Claude CLI activity timeout (90s no output)"));
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

  private emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private resolveIdle(): void {
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
  }
}

// ============================================================================
// ClaudeCliRuntime
// ============================================================================

export class ClaudeCliRuntime implements AgentRuntime {
  readonly name = "claude-cli";
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    thinking: true,
    usage: true,
    dynamicModel: false,
    dynamicThinking: false,
    permissionControl: true,
    sessionResume: true,
  };

  private cliPath: string;
  private handles: ClaudeCliAgentHandle[] = [];
  private mcpFiles: string[] = [];
  private serverPort: number;

  constructor(cliPath?: string, serverPort: number = 8080) {
    this.cliPath = cliPath || "claude";
    this.serverPort = serverPort;
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const path = this.cliPath === "claude"
        ? execSync("which claude", { encoding: "utf-8" }).trim()
        : this.cliPath;
      const version = execSync(`${this.cliPath} --version`, { encoding: "utf-8" }).trim();
      return { available: true, version, path };
    } catch (err: any) {
      return { available: false, error: err.message };
    }
  }

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;

    // Path to compiled MCP server
    const mcpServerPath = join(import.meta.dirname, "../../server/mcp-server.js");

    // Generate MCP config
    const mcpConfigPath = `/tmp/bossmode-mcp-${opts.member.name}-${Date.now()}.json`;
    const mcpConfig = {
      mcpServers: {
        bossmode: {
          command: "node",
          args: [mcpServerPath],
          env: {
            BOSSMODE_SERVER: serverUrl,
            BOSSMODE_ROOM: opts.roomId,
            BOSSMODE_AGENT: opts.member.name,
            BOSSMODE_MEMBERS: opts.roomMembers.join(","),
          },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), "utf-8");
    this.mcpFiles.push(mcpConfigPath);

    // Build system prompt — claude has no --skill flag, so inline skills + team into prompt
    let fullPrompt = opts.agentPrompt;

    // Inline skill content from paths
    const skillTexts: string[] = [];
    for (const sp of opts.skillPaths) {
      const skillMd = join(sp, "SKILL.md");
      if (existsSync(skillMd)) {
        try { skillTexts.push(readFileSync(skillMd, "utf-8")); } catch { /* skip */ }
      }
    }
    if (skillTexts.length > 0) {
      fullPrompt += "\n\n---\n\n# Skills\n\n" + skillTexts.join("\n---\n\n");
    }

    if (opts.rulesPrompt) {
      fullPrompt += `\n\n---\n\n# Rules\n\n${opts.rulesPrompt}`;
    }

    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--system-prompt", fullPrompt,
      "--mcp-config", mcpConfigPath,
      "--dangerously-skip-permissions",
    ];

    // Model: use alias to avoid auth issues with full model IDs
    const modelAlias = mapModelToAlias(opts.member.model);
    if (modelAlias) {
      args.push("--model", modelAlias);
    }

    const effort = mapThinkingToEffort(opts.member.thinkingLevel || "off");
    if (effort !== "medium") {
      args.push("--effort", effort);
    }

    const doSpawn = async (spawnArgs: string[]): Promise<ClaudeCliAgentHandle> => {
      logger.info("runtime:claude-cli", "createAgent", {
        agent: opts.member.name, model: modelAlias || "default",
        thinking: opts.member.thinkingLevel || "off",
        skills: opts.skillPaths.length, cwd: opts.cwd,
      });

      const proc = spawn(this.cliPath, spawnArgs, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: getCleanSpawnEnv(),
      });

      const spawnHeader = `spawn agent="${opts.member.name}" pid=${proc.pid}`;
      console.log(`[${new Date().toISOString()}] INFO [runtime:claude-cli] ${spawnHeader}\n${formatSpawnArgs(this.cliPath, spawnArgs)}`);

      let stderrBuf = "";
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString().trim();
        stderrBuf += text + "\n";
        if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
        if (text) logger.error("runtime:claude-cli", `stderr`, { agent: opts.member.name, text: text.slice(0, 500) });
      });

      proc.on("exit", (code, signal) => {
        logger.info("runtime:claude-cli", "process exit", { agent: opts.member.name, code, signal, stderr: stderrBuf.slice(0, 500) || undefined });
      });

      const handle = new ClaudeCliAgentHandle(proc, `${this.cliPath} ${spawnArgs.join(" ")}`);

      // Quick check: wait 2s for early crashes
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        proc.on("exit", (code) => {
          clearTimeout(timer);
          if (code !== null && code !== 0) {
            resolve(); // Let the handle deal with it on prompt()
          }
        });
      });

      return handle;
    };

    // Try with session resume, fallback to fresh
    let handle: ClaudeCliAgentHandle;
    const sessionId = opts.resumeSession?.sessionId;
    if (sessionId) {
      try {
        const resumeArgs = [...args, "--resume", sessionId];
        handle = await doSpawn(resumeArgs);
        logger.info("runtime:claude-cli", "session resumed", { agent: opts.member.name, sessionId });
      } catch (err: any) {
        logger.warn("runtime:claude-cli", "session resume failed, starting fresh", { agent: opts.member.name, error: err.message });
        handle = await doSpawn(args);
      }
    } else {
      handle = await doSpawn(args);
    }

    // Register session callback — will fire when init event arrives
    if (opts.onSessionCreated) {
      handle.onSessionInfo((session) => {
        opts.onSessionCreated!({ sessionId: session.sessionId });
      });
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

    // Clean up MCP config files
    for (const f of this.mcpFiles) {
      try { unlinkSync(f); } catch {}
    }
    this.mcpFiles = [];
  }
}
