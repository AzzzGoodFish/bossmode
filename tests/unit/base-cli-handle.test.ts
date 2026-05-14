import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BaseCliAgentHandle } from "../../src/engine/runtime/base-cli-handle.js";
import type { AgentStreamEvent, ContextUsage } from "../../src/engine/runtime/types.js";

function createFakeProc() {
  const proc = new EventEmitter() as any;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as any;
  stdin.writable = true;
  stdin.write = vi.fn();

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 9999;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.emit("exit", 0, null);
  });
  return proc;
}

class TestHandle extends BaseCliAgentHandle {
  readonly runtimeName = "test";
  public parsed: any[] = [];

  protected get logScope(): string {
    return "runtime:test";
  }

  protected get runtimeDisplayName(): string {
    return "Test CLI";
  }

  async prompt(_message: string): Promise<void> {
    return this.startWork({ type: "prompt", message: _message });
  }

  steer(_message: string): void {}
  abort(): void {}

  async getContextUsage(): Promise<ContextUsage | null> {
    return null;
  }

  protected buildRequestPayload(id: string, type: string, params?: Record<string, unknown>): unknown {
    return { id, type, ...(params || {}) };
  }

  protected handleParsedLine(raw: any): void {
    this.parsed.push(raw);
  }

  public request(type: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    return this.sendRequest(type, params, timeoutMs, "RPC");
  }

  public resolve(id: string, success: boolean, data?: any, error?: string): boolean {
    return this.resolveRequest(id, success, data, error);
  }

  public begin(payload: unknown): Promise<void> {
    return this.startWork(payload);
  }

  public finish(): void {
    this.endWork();
  }

  public fail(error: string): void {
    this.failWork(error);
  }
}

describe("BaseCliAgentHandle", () => {
  it("emits cli:stdout and parses JSONL lines", () => {
    const proc = createFakeProc();
    const handle = new TestHandle(proc);
    const events: AgentStreamEvent[] = [];
    handle.subscribe((e) => events.push(e));

    proc.stdout.emit("data", Buffer.from('{"a":1}\n{"b":2}\n'));

    expect(events.some((e) => e.type === "cli:stdout")).toBe(true);
    expect(handle.parsed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("sendRequest writes payload and resolves on matching response", async () => {
    const proc = createFakeProc();
    const handle = new TestHandle(proc);

    const p = handle.request("ping", { x: 1 }, 5000);
    const writeArg = proc.stdin.write.mock.calls[0][0] as string;
    const payload = JSON.parse(writeArg.trim());

    expect(payload.type).toBe("ping");
    expect(payload.x).toBe(1);

    const handled = handle.resolve(payload.id, true, { ok: true });
    expect(handled).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("sendRequest times out", async () => {
    vi.useFakeTimers();
    const proc = createFakeProc();
    const handle = new TestHandle(proc);

    const p = handle.request("slow", {}, 10);
    const assertion = expect(p).rejects.toThrow('RPC "slow" timed out (10ms)');
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    vi.useRealTimers();
  });

  it("startWork submits prompt without synthetic agent_start and resolves after endWork", async () => {
    const proc = createFakeProc();
    const handle = new TestHandle(proc);
    const events: AgentStreamEvent[] = [];
    handle.subscribe((e) => events.push(e));

    let done = false;
    const p = handle.begin({ type: "prompt", message: "hi" }).then(() => {
      done = true;
    });

    expect(proc.stdin.write).toHaveBeenCalledWith('{"type":"prompt","message":"hi"}\n');
    expect(events.some((e) => e.type === "agent_start")).toBe(false);
    expect(done).toBe(false);

    handle.finish();
    await p;
    expect(done).toBe(true);
  });

  it("failWork rejects pending prompt without synthetic agent_end", async () => {
    const proc = createFakeProc();
    const handle = new TestHandle(proc);
    const events: AgentStreamEvent[] = [];
    handle.subscribe((e) => events.push(e));

    const p = handle.begin({ type: "prompt", message: "boom" });
    handle.fail("boom");

    await expect(p).rejects.toThrow("boom");
    expect(events.some((e) => e.type === "agent_end")).toBe(false);
  });

  it("destroy rejects pending requests", async () => {
    const proc = createFakeProc();
    const handle = new TestHandle(proc);

    const p = handle.request("slow", {}, 5000);
    handle.destroy();
    await expect(p).rejects.toThrow("Agent destroyed");
  });
});
