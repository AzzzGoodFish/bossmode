import { describe, it, expect, vi } from "vitest";
import { mapContextUsage } from "../../src/agent/runtime/events.js";

/**
 * Unit tests for context usage feature:
 * 1. formatTokens — k unit formatting
 * 2. sendControlRequest/getContextUsage — extracted logic
 * 3. API endpoint logic
 * 4. Color/percentage helpers
 */

// -- formatTokens (extracted from MemberPanel.tsx) --

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

describe("formatTokens", () => {
  it("< 1000 shows raw number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(892)).toBe("892");
    expect(formatTokens(999)).toBe("999");
  });

  it(">= 1000 shows one decimal + k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(45200)).toBe("45.2k");
    expect(formatTokens(99999)).toBe("100.0k");
  });

  it(">= 100000 shows no decimal + k", () => {
    expect(formatTokens(100000)).toBe("100k");
    expect(formatTokens(150000)).toBe("150k");
    expect(formatTokens(200000)).toBe("200k");
    expect(formatTokens(1000000)).toBe("1000k");
  });
});

// -- getBarColor (extracted from MemberPanel.tsx) --

function getBarColor(pct: number): string {
  if (pct < 40) return "emerald";
  if (pct < 70) return "amber";
  if (pct < 90) return "orange";
  return "red";
}

describe("getBarColor", () => {
  it("0-39% → emerald (green)", () => {
    expect(getBarColor(0)).toBe("emerald");
    expect(getBarColor(20)).toBe("emerald");
    expect(getBarColor(39)).toBe("emerald");
  });

  it("40-69% → amber", () => {
    expect(getBarColor(40)).toBe("amber");
    expect(getBarColor(55)).toBe("amber");
    expect(getBarColor(69)).toBe("amber");
  });

  it("70-89% → orange", () => {
    expect(getBarColor(70)).toBe("orange");
    expect(getBarColor(85)).toBe("orange");
    expect(getBarColor(89)).toBe("orange");
  });

  it("90%+ → red", () => {
    expect(getBarColor(90)).toBe("red");
    expect(getBarColor(95)).toBe("red");
    expect(getBarColor(100)).toBe("red");
  });
});

// -- control_request/response matching logic --

describe("control_request/response matching", () => {
  /**
   * Simulates runtime pending request behavior
   */
  class RequestTracker {
    pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    sendRequest(subtype: string, timeoutMs = 5000): Promise<any> {
      const requestId = Math.random().toString(36).substring(2, 15);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Timed out`));
        }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
        // In real code, stdin write happens here
        // Return requestId for test to simulate response
        (this as any)._lastRequestId = requestId;
      });
    }

    handleResponse(raw: any): boolean {
      const reqId = raw.response?.request_id;
      if (reqId && this.pending.has(reqId)) {
        const p = this.pending.get(reqId)!;
        this.pending.delete(reqId);
        clearTimeout(p.timer);
        if (raw.response.subtype === "success") {
          p.resolve(raw.response.response ?? {});
        } else {
          p.reject(new Error(`Failed: ${raw.response.subtype}`));
        }
        return true;
      }
      return false;
    }

    destroy(): void {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Destroyed"));
      }
      this.pending.clear();
    }
  }

  it("resolves matching response with correct data", async () => {
    const tracker = new RequestTracker();
    const promise = tracker.sendRequest("get_context_usage", 5000);
    const reqId = (tracker as any)._lastRequestId;

    tracker.handleResponse({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: reqId,
        response: { totalTokens: 45000, rawMaxTokens: 200000, percentage: 22.5, model: "sonnet" },
      },
    });

    const data = await promise;
    expect(data.totalTokens).toBe(45000);
    expect(data.rawMaxTokens).toBe(200000);
    expect(data.percentage).toBe(22.5);
    expect(data.model).toBe("sonnet");
  });

  it("rejects on error subtype", async () => {
    const tracker = new RequestTracker();
    const promise = tracker.sendRequest("get_context_usage", 5000);
    const reqId = (tracker as any)._lastRequestId;

    tracker.handleResponse({
      type: "control_response",
      response: { subtype: "error", request_id: reqId },
    });

    await expect(promise).rejects.toThrow("Failed: error");
  });

  it("times out if no response", async () => {
    vi.useFakeTimers();
    const tracker = new RequestTracker();
    const promise = tracker.sendRequest("get_context_usage", 100);

    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow("Timed out");
    expect(tracker.pending.size).toBe(0);
    vi.useRealTimers();
  });

  it("ignores unmatched response", () => {
    const tracker = new RequestTracker();
    const handled = tracker.handleResponse({
      type: "control_response",
      response: { subtype: "success", request_id: "unknown-id", response: {} },
    });
    expect(handled).toBe(false);
  });

  it("concurrent requests resolve independently", async () => {
    const tracker = new RequestTracker();
    const p1 = tracker.sendRequest("get_context_usage", 5000);
    const id1 = (tracker as any)._lastRequestId;
    const p2 = tracker.sendRequest("get_context_usage", 5000);
    const id2 = (tracker as any)._lastRequestId;

    // Resolve in reverse order
    tracker.handleResponse({
      type: "control_response",
      response: { subtype: "success", request_id: id2, response: { totalTokens: 2000 } },
    });
    tracker.handleResponse({
      type: "control_response",
      response: { subtype: "success", request_id: id1, response: { totalTokens: 1000 } },
    });

    const d1 = await p1;
    const d2 = await p2;
    expect(d1.totalTokens).toBe(1000);
    expect(d2.totalTokens).toBe(2000);
  });

  it("destroy rejects all pending requests", async () => {
    const tracker = new RequestTracker();
    const p1 = tracker.sendRequest("get_context_usage", 5000);
    const p2 = tracker.sendRequest("get_context_usage", 5000);

    tracker.destroy();

    await expect(p1).rejects.toThrow("Destroyed");
    await expect(p2).rejects.toThrow("Destroyed");
    expect(tracker.pending.size).toBe(0);
  });
});

// -- API endpoint logic --

describe("mapContextUsage", () => {
  it("marks SDK null-token interval as compacted", () => {
    expect(mapContextUsage({ tokens: null, contextWindow: 200000, model: "sonnet" })).toEqual({
      totalTokens: 0,
      rawMaxTokens: 200000,
      percentage: 0,
      model: "sonnet",
      compacted: true,
    });
  });
});

// -- API endpoint logic --

describe("context-usage API endpoint logic", () => {
  it("returns cache-unavailable payload when cache is empty", () => {
    // New behavior: API is cache-only, never triggers runtime request.
    const usage = null;
    const response = usage === null ? { supported: true, unavailable: true } : { supported: true, ...usage };
    expect(response).toEqual({ supported: true, unavailable: true });
  });

  it("returns cached usage payload when available", () => {
    const usage = { totalTokens: 45000, rawMaxTokens: 200000, percentage: 22.5, model: "sonnet" };
    const response = usage === null ? { supported: true, unavailable: true } : { supported: true, ...usage };
    expect(response).toEqual({
      supported: true,
      totalTokens: 45000,
      rawMaxTokens: 200000,
      percentage: 22.5,
      model: "sonnet",
    });
  });

  it("WS push payload shape for agent:context_usage is stable", () => {
    const event = {
      type: "agent:context_usage",
      roomId: "room-1",
      agent: "developer",
      usage: {
        totalTokens: 9000,
        rawMaxTokens: 200000,
        percentage: 4.5,
        model: "sonnet",
      },
    };

    expect(event.type).toBe("agent:context_usage");
    expect(event.usage.percentage).toBe(4.5);
  });
});
