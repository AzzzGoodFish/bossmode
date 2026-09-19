import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/kernel/logger.js";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info outputs structured line to console.log", () => {
    logger.info("api", "request received", { method: "POST" });
    expect(logSpy).toHaveBeenCalledOnce();
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[.*\] INFO \[api\] request received \{.*"method":"POST".*\}$/);
  });

  it("warn outputs to console.warn", () => {
    logger.warn("runtime", "slow response");
    expect(warnSpy).toHaveBeenCalledOnce();
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/WARN \[runtime\] slow response$/);
  });

  it("error outputs to console.error", () => {
    logger.error("agent", "failed", { code: 1 });
    expect(errorSpy).toHaveBeenCalledOnce();
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/ERROR \[agent\] failed \{.*"code":1.*\}$/);
  });

  it("works without data parameter", () => {
    logger.info("ws", "connected");
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/INFO \[ws\] connected$/);
    expect(line).not.toContain("{");
  });

  it("includes ISO timestamp", () => {
    logger.info("test", "check");
    const line = logSpy.mock.calls[0][0] as string;
    // ISO format: 2026-03-25T...Z
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
