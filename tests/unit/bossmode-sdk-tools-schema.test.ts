import { describe, expect, it, vi } from "vitest";

// Backend errors (ok:false) must surface as thrown errors in every SDK tool
// wrapper — a silent "No messages found." / "Failed to load tasks." was the
// exact silent-fallback trap the rc.8 param unification aimed to kill (QA
// caught query_room_messages / list_tasks swallowing ok:false).
vi.mock("../../src/engine/tools.js", () => ({
  handleToolCallback: vi.fn(async () => ({ ok: false, error: "boom: explicit error" })),
}));

import { createBossmodeSdkTools } from "../../src/engine/runtime/bossmode-sdk-tools.js";

// Defensive contract: every custom tool must serialize its JSON Schema with an
// explicit `required` array. TypeBox omits it when all properties are optional
// (valid JSON Schema), but some OpenAI-compatible adapters (e.g. cloudrouter's
// OpenAI→Anthropic conversion) silently return an empty stream for such tools,
// surfacing as "Stream ended without finish_reason".
describe("createBossmodeSdkTools schema normalization", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", agentName: "tester", roomMembers: ["tester"] });

  it("emits a `required` array on every tool's parameters", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const params = tool.parameters as { type?: string; required?: unknown };
      expect(params.type).toBe("object");
      expect(Array.isArray(params.required), `tool "${tool.name}" must emit a required array`).toBe(true);
    }
  });

  it("marks all-optional tools with required: []", () => {
    for (const name of ["query_room_messages", "list_tasks", "query_integration"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool "${name}" should exist`).toBeDefined();
      expect((tool!.parameters as { required?: unknown }).required).toEqual([]);
    }
  });

  it("keeps genuinely required fields intact", () => {
    const commentTask = tools.find((t) => t.name === "comment_task");
    expect((commentTask!.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["taskId", "comment"]),
    );
  });
});

describe("createBossmodeSdkTools error surfacing", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", agentName: "tester", roomMembers: ["tester"] });

  it("query_room_messages surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "query_room_messages")!;
    await expect((tool.execute as any)?.("id", { query: "x" })).rejects.toThrow("boom: explicit error");
  });

  it("list_tasks surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "list_tasks")!;
    await expect((tool.execute as any)?.("id", {})).rejects.toThrow("boom: explicit error");
  });
});
