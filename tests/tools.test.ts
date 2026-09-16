import { describe, it, expect, vi } from "vitest";
import { MockRuntime, MockAgentHandle } from "./helpers/mock-runtime.js";
import { truncateToolResult } from "../src/agent/tools/tools.js";

describe("MockRuntime", () => {
  it("should have correct name and capabilities", () => {
    const runtime = new MockRuntime();
    expect(runtime.name).toBe("mock");
    expect(runtime.capabilities.streaming).toBe(true);
    expect(runtime.capabilities.toolEvents).toBe(true);
  });

  it("should detect as available", async () => {
    const runtime = new MockRuntime();
    const result = await runtime.detect();
    expect(result.available).toBe(true);
  });

  it("should create an agent handle", async () => {
    const runtime = new MockRuntime();
    const handle = await runtime.createAgent({
      cwd: "/tmp",
      member: {
        id: "test",
        name: "test",
        agentSource: "test.md",
        model: "mock-model",
        runtime: "mock",
        skills: [],
        thinkingLevel: "off",
      },
      agentPrompt: "You are a test agent.",
      skillPaths: [],
      roomMembers: ["test"],
      callbacks: {
        onChat: vi.fn().mockResolvedValue(undefined),
        onMention: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(handle).toBeDefined();
    expect(handle.isWorking).toBe(false);
    expect(typeof handle.prompt).toBe("function");
    expect(typeof handle.compact).toBe("function");
  });

  it("should shutdown cleanly", async () => {
    const runtime = new MockRuntime();
    await expect(runtime.shutdownAll()).resolves.toBeUndefined();
  });
});

describe("truncateToolResult", () => {
  it("passes through short text unchanged", () => {
    const text = "Hello world";
    expect(truncateToolResult(text)).toBe(text);
  });

  it("passes through text at exactly the limit", () => {
    const text = "a".repeat(25_000);
    expect(truncateToolResult(text)).toBe(text);
  });

  it("truncates text exceeding the limit with a message", () => {
    const text = "x".repeat(30_000);
    const result = truncateToolResult(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("Result truncated");
    expect(result).toContain("30000 chars");
    expect(result).toContain("25000 limit");
    // Starts with the original content
    expect(result.startsWith("x".repeat(25_000))).toBe(true);
  });
});
