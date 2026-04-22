// Claude CLI Runtime — spawn claude --input-format stream-json, event mapping, MCP config
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { logger, formatSpawnArgs } from "../../foundation/logger.js";
import { getCleanSpawnEnv } from "./env.js";
import { BaseCliAgentHandle } from "./base-cli-handle.js";
import type {
  AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts,
  RuntimeCapabilities, RuntimeDetectResult, TokenUsage, ContextUsage,
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
// Preserves [1m] suffix for 1M extended context window
function mapModelToAlias(model: string): string | undefined {
  const m = model.toLowerCase();
  const suffix = m.includes("[1m]") ? "[1m]" : "";
  const base = m.replace("[1m]", "");
  if (base.includes("opus")) return "opus" + suffix;
  if (base.includes("sonnet")) return "sonnet" + suffix;
  if (base.includes("haiku")) return "haiku" + suffix;
  // Return as-is if it's already an alias or unknown
  if (["opus", "sonnet", "haiku"].includes(base)) return base + suffix;
  return model; // Try as-is, may fail
}

// ============================================================================
// Event Mapping
// ============================================================================

function mapClaudeEvent(raw: any, state: ClaudeParseState): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  switch (raw.type) {
    case "system":
      state.sessionId = raw.session_id;
      state.initialized = true;
      // Map compact_boundary events to a visible message
      if (raw.subtype === "compact_boundary" && raw.compact_metadata) {
        const preTokens = raw.compact_metadata.pre_tokens;
        events.push({ type: "message_start" });
        events.push({ type: "message_end", text: `Context compacted. Tokens before: ${preTokens}` });
      }
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

    case "control_response":
      // Response to our interrupt request — acknowledged, no action needed
      logger.info("runtime:claude-cli", "control_response", { subtype: raw.response?.subtype, requestId: raw.request_id });
      break;

    default:
      logger.info("runtime:claude-cli", "unhandled event type", { type: raw.type });
      break;
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

class ClaudeCliAgentHandle extends BaseCliAgentHandle implements AgentHandle {
  readonly runtimeName = "claude-cli";
  private sessionChangeCallback: ((session: { sessionId?: string }) => void) | null = null;
  private state: ClaudeParseState = { initialized: false, inMessage: false, toolNames: new Map() };
  private cachedContextUsage: ContextUsage | null = null;
  private cachedContextUsageTs = 0;
  private static CONTEXT_CACHE_TTL = 120_000;

  constructor(proc: ChildProcessWithoutNullStreams, spawnArgs?: string[], initialStderr?: string) {
    super(proc, {
      spawnArgs,
      initialStderr,
      captureStderr: true,
      emitStderrEvents: true,
    });
  }

  protected get logScope(): string {
    return "runtime:claude-cli";
  }

  protected get runtimeDisplayName(): string {
    return "Claude CLI";
  }

  protected onStdoutParseError(line: string, err: unknown): void {
    logger.warn("runtime:claude-cli", "stdout JSON parse failed", {
      line: line.substring(0, 200),
      error: String(err),
    });
  }

  async prompt(message: string): Promise<void> {
    return this.startWork({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    });
  }

  steer(message: string): void {
    this.safeStdinWrite(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    }) + "\n");
  }

  abort(): void {
    const requestId = Math.random().toString(36).substring(2, 15);
    this.safeStdinWrite(JSON.stringify({
      request_id: requestId,
      type: "control_request",
      request: { subtype: "interrupt" },
    }) + "\n");
  }

  onSessionChange(cb: (session: { sessionId?: string }) => void): void {
    this.sessionChangeCallback = cb;
  }

  protected buildRequestPayload(id: string, type: string): unknown {
    return {
      type: "control_request",
      request: { subtype: type },
      request_id: id,
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    try {
      const data = await this.sendRequest("get_context_usage", {}, 15000, "control_request");
      const usage: ContextUsage = {
        totalTokens: data.totalTokens ?? 0,
        rawMaxTokens: data.rawMaxTokens ?? 0,
        percentage: data.percentage ?? 0,
        model: data.model ?? "unknown",
      };
      this.cachedContextUsage = usage;
      this.cachedContextUsageTs = Date.now();
      return usage;
    } catch (err) {
      logger.warn("runtime:claude-cli", "getContextUsage failed", { pid: this.pid, error: String(err) });
      if (this.cachedContextUsage && (Date.now() - this.cachedContextUsageTs) < ClaudeCliAgentHandle.CONTEXT_CACHE_TTL) {
        return this.cachedContextUsage;
      }
      return null;
    }
  }

  protected handleParsedLine(raw: any): void {
    logger.info("runtime:claude-cli", "raw", { type: raw.type, subtype: raw.subtype, keys: Object.keys(raw) });

    if (raw.type === "system") {
      const incomingSessionId = raw.session_id;
      const prevSessionId = this.state.sessionId;

      if (!this.state.initialized) {
        this.state.initialized = true;
        logger.info("runtime:claude-cli", "init received", { sessionId: incomingSessionId, pid: this.pid });
      }

      if (incomingSessionId && incomingSessionId !== prevSessionId) {
        this.state.sessionId = incomingSessionId;
        if (this.sessionChangeCallback) {
          this.sessionChangeCallback({ sessionId: incomingSessionId });
        }
      }
    }

    if (raw.type === "control_response" && raw.response) {
      const reqId = raw.response.request_id;
      if (reqId && this.resolveRequest(reqId, raw.response.subtype === "success", raw.response.response, `control_request failed: ${raw.response.subtype}`)) {
        return;
      }
    }

    const mapped = mapClaudeEvent(raw, this.state);
    for (const event of mapped) {
      if (event.type === "agent_end") {
        this.endWork();
      }
      this.emit(event);
    }
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
    contextUsage: true,
  };

  private cliPath: string;
  private handles: ClaudeCliAgentHandle[] = [];
  private serverPort: number;
  private hookSettingsDir = "/tmp";
  private hookSettingsFiles: string[] = [];

  constructor(cliPath?: string, serverPort: number = 8080) {
    this.cliPath = cliPath || "claude";
    this.serverPort = serverPort;
    this.cleanupLegacyMcpTempFiles();
  }

  private cleanupLegacyMcpTempFiles(): void {
    try {
      const files = readdirSync(this.hookSettingsDir);
      for (const file of files) {
        if (!file.startsWith("bossmode-mcp-") || !file.endsWith(".json")) continue;
        try {
          unlinkSync(join(this.hookSettingsDir, file));
        } catch {
          // best effort cleanup
        }
      }
    } catch {
      // best effort cleanup
    }
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

  private resolveSessionHookForwarderPath(): string {
    const distPath = join(import.meta.dirname, "../../scripts/session_hook_forwarder.cjs");
    if (existsSync(distPath)) return distPath;
    return join(import.meta.dirname, "../../../scripts/session_hook_forwarder.cjs");
  }

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;

    const mcpConfig = {
      mcpServers: {
        bossmode: {
          type: "http",
          url: `${serverUrl}/mcp/${opts.roomId}/${opts.member.name}`,
        },
      },
    };
    const mcpConfigJson = JSON.stringify(mcpConfig);

    const hookSettingsPath = `${this.hookSettingsDir}/bossmode-hook-${opts.member.name}-${Date.now()}.json`;
    const forwarderPath = this.resolveSessionHookForwarderPath();
    const hookSettings = {
      hooks: {
        SessionStart: [{
          matcher: "*",
          hooks: [{
            type: "command",
            command: `node ${forwarderPath} ${this.serverPort} ${opts.roomId} ${opts.member.name}`,
          }],
        }],
      },
    };
    writeFileSync(hookSettingsPath, JSON.stringify(hookSettings), "utf-8");
    this.hookSettingsFiles.push(hookSettingsPath);

    // Symlink skills to ~/.claude/skills/ so Claude Code discovers them natively.
    // This replaces the old approach of inlining skill text into --system-prompt.
    // Benefits: skills load on-demand (via /skill-name or SkillTool), saving tokens.
    const createdSymlinks: string[] = [];
    const claudeSkillsDir = join(homedir(), ".claude", "skills");
    mkdirSync(claudeSkillsDir, { recursive: true });
    for (const sp of opts.skillPaths) {
      if (!existsSync(sp)) continue;
      const skillName = basename(sp);
      const target = join(claudeSkillsDir, skillName);
      if (!existsSync(target)) {
        try {
          symlinkSync(sp, target);
          createdSymlinks.push(target);
        } catch (err: any) {
          logger.warn("runtime:claude-cli", "symlink skill failed", { skill: skillName, error: err.message });
        }
      }
    }

    // Decide injection strategy based on whether agentPrompt has content
    const hasAgentPrompt = opts.agentPrompt.trim().length > 0;

    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--mcp-config", mcpConfigJson,
      "--settings", hookSettingsPath,
      "--dangerously-skip-permissions",
    ];

    if (hasAgentPrompt) {
      // Override mode: agentPrompt + rules + env all in --system-prompt
      let fullPrompt = opts.agentPrompt;
      if (opts.rulesPrompt) {
        fullPrompt += `\n\n---\n\n# Rules\n\n${opts.rulesPrompt}`;
      }
      fullPrompt += "\n" + opts.envPrompt;
      args.push("--system-prompt", fullPrompt);
    } else {
      // Append mode: preserve CLI default system prompt, append env + rules
      let appendPrompt = opts.envPrompt;
      if (opts.rulesPrompt) {
        appendPrompt += `\n\n---\n\n# Rules\n\n${opts.rulesPrompt}`;
      }
      args.push("--append-system-prompt", appendPrompt);
    }

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

      const handle = new ClaudeCliAgentHandle(proc, [this.cliPath, ...spawnArgs]);

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

    // Register session callback — can fire multiple times after compact/fork
    if (opts.onSessionChanged) {
      handle.onSessionChange((session) => {
        opts.onSessionChanged!({ sessionId: session.sessionId });
      });
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

    for (const f of this.hookSettingsFiles) {
      try { unlinkSync(f); } catch {}
    }
    this.hookSettingsFiles = [];
  }
}
