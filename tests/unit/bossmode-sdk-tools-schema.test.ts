import { describe, expect, it, vi } from "vitest";

// Backend errors (ok:false) must surface as thrown errors in every SDK tool
// wrapper — a silent "No messages found." / "Failed to load tasks." was the
// exact silent-fallback trap the rc.8 param unification aimed to kill (QA
// caught query_room_messages / list_tasks swallowing ok:false).
vi.mock("../../src/engine/tools.js", () => ({
  handleToolCallback: vi.fn(async () => ({ ok: false, error: "boom: explicit error" })),
}));

import { handleToolCallback } from "../../src/engine/tools.js";
import { createBossmodeSdkTools } from "../../src/engine/runtime/bossmode-sdk-tools.js";

// Defensive contract: every custom tool must serialize its JSON Schema with an
// explicit `required` array. TypeBox omits it when all properties are optional
// (valid JSON Schema), but some OpenAI-compatible adapters (e.g. cloudrouter's
// OpenAI→Anthropic conversion) silently return an empty stream for such tools,
// surfacing as "Stream ended without finish_reason".
describe("createBossmodeSdkTools schema normalization", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", memberId: "mem-tester" });

  it("emits a `required` array on every tool's parameters", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const params = tool.parameters as { type?: string; required?: unknown };
      expect(params.type).toBe("object");
      expect(Array.isArray(params.required), `tool "${tool.name}" must emit a required array`).toBe(true);
    }
  });

  it("marks all-optional tools with required: []", () => {
    for (const name of ["query_room_messages", "list_scopes"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool "${name}" should exist`).toBeDefined();
      expect((tool!.parameters as { required?: unknown }).required).toEqual([]);
    }
  });

  it("keeps genuinely required fields intact", () => {
    const workspaceCreate = tools.find((t) => t.name === "workspace_create");
    expect((workspaceCreate!.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["id", "host", "user"]),
    );
  });

  it("linear integration tools are removed from the tool surface", () => {
    expect(tools.find((t) => t.name === "query_integration")).toBeUndefined();
    expect(tools.find((t) => t.name === "configure_integration")).toBeUndefined();
  });
});

describe("createBossmodeSdkTools error surfacing", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", memberId: "mem-tester" });

  it("query_room_messages surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "query_room_messages")!;
    await expect((tool.execute as any)?.("id", { query: "x" })).rejects.toThrow("boom: explicit error");
  });

  it("list_scopes surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "list_scopes")!;
    await expect((tool.execute as any)?.("id", {})).rejects.toThrow("boom: explicit error");
  });
});


describe("update_profile SDK contract", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", memberId: "mem-tester" });
  const tool = tools.find((t) => t.name === "update_profile")!;

  it("declares only optional name/title and rejects extra properties", () => {
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false, required: [] });
    expect(Object.keys((tool.parameters as any).properties)).toEqual(["name", "title"]);
    expect((tool.parameters as any).properties.name.type).toBe("string");
    expect((tool.parameters as any).properties.title.type).toBe("string");
  });

  it("does not cache roster names in the chat declaration", () => {
    const chat = tools.find((t) => t.name === "chat")!;
    expect(chat.description).not.toContain("old-name");
    expect(chat.description).not.toContain("stale-peer");
    expect(chat.description).not.toContain("Room members:");
    expect(chat.description).toContain("@name activates");
  });

  it.each([true, false])("returns the committed result with changed=%s using trusted member identity", async (changed) => {
    const committed = { ok: true, memberId: "mem-tester", name: "new-name", title: "", changed };
    vi.mocked(handleToolCallback).mockResolvedValueOnce(committed as any);
    const result = await (tool.execute as any)("id", { name: "new-name", title: "" });
    expect(JSON.parse(result.content[0].text)).toEqual(committed);
    expect(handleToolCallback).toHaveBeenLastCalledWith("update_profile", "r1", "mem-tester", { name: "new-name", title: "" }, { memberId: "mem-tester", execution: undefined });
  });

  it("preserves structured errors and delegates empty-patch validation to the parent", async () => {
    const failure = { ok: false, error: "At least one field is required", code: "invalid_profile", fields: ["name", "title"] };
    vi.mocked(handleToolCallback).mockResolvedValueOnce(failure as any);
    await expect((tool.execute as any)("id", {})).rejects.toThrow(JSON.stringify(failure));
    expect(handleToolCallback).toHaveBeenLastCalledWith("update_profile", "r1", "mem-tester", {}, { memberId: "mem-tester", execution: undefined });
  });

  it("does not mask a thrown service failure", async () => {
    const failure = Object.assign(new Error("conflicting member name"), { code: "name_conflict" });
    vi.mocked(handleToolCallback).mockRejectedValueOnce(failure);
    await expect((tool.execute as any)("id", { name: "taken" })).rejects.toBe(failure);
  });
});
