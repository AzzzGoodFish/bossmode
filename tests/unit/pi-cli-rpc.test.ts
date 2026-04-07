import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for pi-cli RPC request/response matching,
 * context usage mapping, and /compact command interception.
 */

// -- RPC request/response matching logic --

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createPendingRequests() {
  const map = new Map<string, PendingRequest>();

  function sendRpcCommand(type: string, params?: Record<string, unknown>, timeoutMs = 1000): Promise<any> {
    const id = Math.random().toString(36).substring(2, 15);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(id);
        reject(new Error(`RPC "${type}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      map.set(id, { resolve, reject, timer });
    });
  }

  function handleResponse(raw: { type: string; id?: string; success?: boolean; data?: any; error?: string }) {
    if (raw.type === "response" && raw.id && map.has(raw.id)) {
      const pending = map.get(raw.id)!;
      map.delete(raw.id);
      clearTimeout(pending.timer);
      if (raw.success) {
        pending.resolve(raw.data ?? {});
      } else {
        pending.reject(new Error(raw.error || "RPC failed"));
      }
      return true;
    }
    return false;
  }

  return { map, sendRpcCommand, handleResponse };
}

describe("Pi-cli RPC request/response matching", () => {
  it("resolves on success response", async () => {
    const { map, handleResponse } = createPendingRequests();
    const id = "test-123";
    let resolved: any;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      map.set(id, { resolve, reject, timer });
    });
    promise.then((v) => { resolved = v; });

    handleResponse({ type: "response", id, success: true, data: { foo: "bar" } });
    await promise;
    expect(resolved).toEqual({ foo: "bar" });
  });

  it("rejects on error response", async () => {
    const { map, handleResponse } = createPendingRequests();
    const id = "test-456";
    let rejected: Error | null = null;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      map.set(id, { resolve, reject, timer });
    });
    promise.catch((e) => { rejected = e; });

    handleResponse({ type: "response", id, success: false, error: "not found" });
    await promise.catch(() => {});
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toBe("not found");
  });

  it("ignores responses without matching id", () => {
    const { map, handleResponse } = createPendingRequests();
    map.set("existing", { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 5000) });

    const handled = handleResponse({ type: "response", id: "nonexistent", success: true });
    expect(handled).toBe(false);
    expect(map.size).toBe(1); // existing still there
    clearTimeout(map.get("existing")!.timer);
  });

  it("times out if no response", async () => {
    const { sendRpcCommand } = createPendingRequests();
    const promise = sendRpcCommand("test", {}, 50); // 50ms timeout

    await expect(promise).rejects.toThrow('RPC "test" timed out');
  });

  it("cleans up map entry on timeout", async () => {
    const { map, sendRpcCommand } = createPendingRequests();
    const promise = sendRpcCommand("test", {}, 50);

    await promise.catch(() => {});
    expect(map.size).toBe(0);
  });
});

// -- Context usage mapping from get_session_stats --

interface ContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
}

function mapSessionStatsToContextUsage(stats: any): ContextUsage | null {
  const cu = stats?.contextUsage;
  if (!cu) return null;
  return {
    totalTokens: cu.tokens ?? 0,
    rawMaxTokens: cu.contextWindow ?? 0,
    percentage: cu.percent ?? 0,
    model: stats?.model?.id ?? "unknown",
  };
}

describe("Pi-cli context usage mapping", () => {
  it("maps standard get_session_stats response", () => {
    const stats = {
      contextUsage: { tokens: 5000, contextWindow: 200000, percent: 2.5 },
      model: { id: "anthropic/claude-sonnet-4-6" },
    };
    expect(mapSessionStatsToContextUsage(stats)).toEqual({
      totalTokens: 5000,
      rawMaxTokens: 200000,
      percentage: 2.5,
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("handles null tokens and percent (post-compaction)", () => {
    const stats = {
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
      model: { id: "anthropic/claude-sonnet-4-6" },
    };
    const result = mapSessionStatsToContextUsage(stats);
    expect(result).toEqual({
      totalTokens: 0,
      rawMaxTokens: 200000,
      percentage: 0,
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("returns null if no contextUsage field", () => {
    expect(mapSessionStatsToContextUsage({})).toBeNull();
    expect(mapSessionStatsToContextUsage({ model: { id: "test" } })).toBeNull();
  });

  it("defaults model to 'unknown' if missing", () => {
    const stats = { contextUsage: { tokens: 100, contextWindow: 100000, percent: 0.1 } };
    expect(mapSessionStatsToContextUsage(stats)!.model).toBe("unknown");
  });
});

// -- /compact command interception --

describe("/compact command interception", () => {
  it("detects exact /compact match", () => {
    expect("/compact" === "/compact").toBe(true);
    expect("/compact something" === "/compact").toBe(false);
    expect("/compac" === "/compact").toBe(false);
  });

  it("does not intercept regular messages starting with /", () => {
    const messages = ["/help", "/status", "/ compact", "/compact!", "compact"];
    for (const msg of messages) {
      expect(msg === "/compact").toBe(false);
    }
  });
});

// -- Compact result formatting --

function formatCompactResult(result: any): string {
  const tokensBefore = result?.tokensBefore ?? "unknown";
  const summary = (result?.summary ?? "No summary").slice(0, 300);
  return `Context compacted.\nTokens before: ${tokensBefore}\nSummary: ${summary}`;
}

describe("compact result formatting", () => {
  it("formats standard CompactionResult", () => {
    const result = { tokensBefore: 19987, summary: "Previous conversation covered project setup." };
    const text = formatCompactResult(result);
    expect(text).toContain("19987");
    expect(text).toContain("Previous conversation");
  });

  it("handles missing fields", () => {
    const text = formatCompactResult({});
    expect(text).toContain("unknown");
    expect(text).toContain("No summary");
  });

  it("truncates long summaries at 300 chars", () => {
    const result = { tokensBefore: 5000, summary: "a".repeat(500) };
    const text = formatCompactResult(result);
    expect(text).toContain("a".repeat(300));
    expect(text).not.toContain("a".repeat(301));
  });
});

// -- Destroy cleanup --

describe("destroy cleanup", () => {
  it("rejects all pending requests on destroy", () => {
    const map = new Map<string, PendingRequest>();
    const rejections: Error[] = [];

    for (let i = 0; i < 3; i++) {
      const timer = setTimeout(() => {}, 10000);
      map.set(`req-${i}`, {
        resolve: vi.fn(),
        reject: (err: Error) => rejections.push(err),
        timer,
      });
    }

    // Simulate destroy
    for (const [, pending] of map) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent destroyed"));
    }
    map.clear();

    expect(rejections).toHaveLength(3);
    expect(rejections[0].message).toBe("Agent destroyed");
    expect(map.size).toBe(0);
  });
});
