import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../../foundation/logger.js";
import type { AgentHandle, AgentStreamEvent, ContextUsage } from "./types.js";

type PendingRequest = {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const STDERR_TAIL_MAX = 1024;

type BaseCliHandleOptions = {
  spawnArgs?: string[];
  initialStderr?: string;
  captureStderr?: boolean;
  emitStderrEvents?: boolean;
};

export abstract class BaseCliAgentHandle implements AgentHandle {
  protected proc: ChildProcessWithoutNullStreams;
  protected listeners = new Set<(event: AgentStreamEvent) => void>();
  protected _isWorking = false;
  protected idleResolvers: Array<() => void> = [];
  protected promptRejecter: ((err: Error) => void) | null = null;
  protected buffer = "";
  protected activityTimer: ReturnType<typeof setTimeout> | null = null;
  protected pendingRequests = new Map<string, PendingRequest>();
  protected destroyed = false;
  protected exitEmitted = false;
  protected stderrTail = "";

  readonly pid: number | undefined;
  abstract readonly runtimeName: string;
  readonly spawnArgs: string[];

  constructor(proc: ChildProcessWithoutNullStreams, options?: BaseCliHandleOptions) {
    this.proc = proc;
    this.pid = proc.pid;
    this.spawnArgs = options?.spawnArgs || [];
    if (options?.initialStderr) this.appendStderr(options.initialStderr);

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      this.resetActivityTimer();
      this.emit({ type: "cli:stdout", text });
      this.buffer += text;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleParsedLine(JSON.parse(line));
        } catch (err) {
          this.onStdoutParseError(line, err);
        }
      }
    });

    proc.on("error", (err) => {
      logger.error(this.logScope, "process error", { pid: this.pid, error: err.message });
      this.clearActivityTimer();
      if (this._isWorking) {
        this._isWorking = false;
        this.emit({ type: "agent_end" });
      }
      if (this.promptRejecter) {
        this.promptRejecter(new Error(`${this.runtimeDisplayName} process error: ${err.message}`));
        this.promptRejecter = null;
      }
      this.resolveIdle();
    });

    proc.stdin.on("error", (err) => {
      logger.error(this.logScope, "stdin error", { pid: this.pid, error: err.message });
    });

    proc.on("exit", (code, signal) => {
      this.clearActivityTimer();
      if (this._isWorking) {
        this._isWorking = false;
        this.emit({ type: "agent_end" });
      }
      this.emitRuntimeExit(code, signal);
      this.resolveIdle();
    });

    if (options?.captureStderr) {
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        this.appendStderr(text);
        if (options.emitStderrEvents && text.trim()) {
          this.emit({ type: "cli:stderr", text });
        }
      });
    }
  }

  protected abstract get logScope(): string;
  protected abstract get runtimeDisplayName(): string;

  protected startWork(stdinPayload: unknown): Promise<void> {
    this._isWorking = true;
    this.emit({ type: "agent_start" });
    this.safeStdinWrite(JSON.stringify(stdinPayload) + "\n");
    this.resetActivityTimer();
    return new Promise<void>((resolve, reject) => {
      this.idleResolvers.push(resolve);
      this.promptRejecter = reject;
    });
  }

  protected sendCommand(payload: unknown): void {
    this.safeStdinWrite(JSON.stringify(payload) + "\n");
  }

  protected endWork(): void {
    this._isWorking = false;
    this.promptRejecter = null;
    this.clearActivityTimer();
    this.resolveIdle();
  }

  protected failWork(error: string): void {
    this._isWorking = false;
    this.clearActivityTimer();
    if (this.promptRejecter) {
      this.promptRejecter(new Error(error));
      this.promptRejecter = null;
    }
    this.emit({ type: "agent_end" });
    this.resolveIdle();
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

  destroy(): void {
    this.destroyed = true;
    this.clearActivityTimer();
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent destroyed"));
    }
    this.pendingRequests.clear();
    try {
      this.proc.kill();
    } catch {
      // best effort
    }
    this.listeners.clear();
    this.resolveIdle();
  }

  protected emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  protected resolveIdle(): void {
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
  }

  protected resetActivityTimer(): void {
    this.clearActivityTimer();
    if (!this._isWorking) return;
    this.activityTimer = setTimeout(() => {
      logger.warn(this.logScope, "no stdout activity for 90s — agent may be stuck", { timeoutMs: 90000, pid: this.proc.pid });
    }, 90000);
  }

  protected clearActivityTimer(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  protected safeStdinWrite(data: string): void {
    try {
      if (this.proc.stdin.writable && !this.proc.killed) {
        this.proc.stdin.write(data);
      } else {
        logger.error(this.logScope, "stdin not writable", { pid: this.pid, killed: this.proc.killed });
      }
    } catch (err: any) {
      logger.error(this.logScope, "stdin write failed", { pid: this.pid, error: err.message });
    }
  }

  protected appendStderr(text: string): void {
    if (!text) return;
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX);
  }

  protected emitRuntimeExit(code: number | null, signal: NodeJS.Signals | null): void {
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

  protected sendRequest(
    type: string,
    params?: Record<string, unknown>,
    timeoutMs = 10000,
    requestLabel = "Request",
  ): Promise<any> {
    const id = Math.random().toString(36).substring(2, 15);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${requestLabel} "${type}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.safeStdinWrite(JSON.stringify(this.buildRequestPayload(id, type, params)) + "\n");
    });
  }

  protected resolveRequest(id: string, success: boolean, data?: any, error?: string): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (success) pending.resolve(data ?? {});
    else pending.reject(new Error(error || "request failed"));
    return true;
  }

  protected onStdoutParseError(_line: string, _err: unknown): void {
    // default: ignore non-JSON lines
  }

  protected abstract buildRequestPayload(id: string, type: string, params?: Record<string, unknown>): unknown;
  protected abstract handleParsedLine(raw: any): void;

  abstract prompt(message: string): Promise<void>;
  abstract steer(message: string): void;
  abstract abort(): void;
  abstract getContextUsage(): Promise<ContextUsage | null>;
}
