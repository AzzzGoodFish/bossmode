import { describe, it, expect, vi } from "vitest";
import { MockRuntime, MockAgentHandle } from "./helpers/mock-runtime.js";

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
    expect(typeof handle.steer).toBe("function");
  });

  it("should shutdown cleanly", async () => {
    const runtime = new MockRuntime();
    await expect(runtime.shutdownAll()).resolves.toBeUndefined();
  });
});
