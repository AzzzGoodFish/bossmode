import { describe, expect, it, vi } from "vitest";

// Backend errors (ok:false) must surface as thrown errors in every SDK tool
// wrapper — a silent "No messages found." / "Failed to load tasks." was the
// exact silent-fallback trap the rc.8 param unification aimed to kill (QA
// caught history reads / list_tasks swallowing ok:false). Batch 3 keeps
// the rule for chat_send / chat_read / chat_search / chat_list and the
// bossmode gateway `call` path.
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
    for (const name of ["chat_list", "workspace_list"]) {
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
    expect((tools.find((t) => t.name === "chat_send")!.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["to", "message"]),
    );
    expect((tools.find((t) => t.name === "chat_read")!.parameters as { required?: string[] }).required).toEqual(["chat"]);
    expect((tools.find((t) => t.name === "chat_search")!.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["chat", "query"]),
    );
  });

  it("linear integration tools are removed from the tool surface", () => {
    expect(tools.find((t) => t.name === "query_integration")).toBeUndefined();
    expect(tools.find((t) => t.name === "configure_integration")).toBeUndefined();
  });
});

describe("createBossmodeSdkTools error surfacing", () => {
  const tools = createBossmodeSdkTools({ roomId: "r1", memberId: "mem-tester" });

  it("chat_read surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "chat_read")!;
    await expect((tool.execute as any)?.("id", { chat: "x" })).rejects.toThrow("boom: explicit error");
  });

  it("chat_search surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "chat_search")!;
    await expect((tool.execute as any)?.("id", { chat: "x", query: "q" })).rejects.toThrow("boom: explicit error");
  });

  it("chat_send surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "chat_send")!;
    await expect((tool.execute as any)?.("id", { to: "x", message: "m" })).rejects.toThrow("boom: explicit error");
  });

  it("chat_list surfaces backend ok:false as a thrown error", async () => {
    const tool = tools.find((t) => t.name === "chat_list")!;
    await expect((tool.execute as any)?.("id", {})).rejects.toThrow("boom: explicit error");
  });
});

describe("bossmode gateway", () => {
  const gateway = createBossmodeSdkTools({ roomId: "r1", memberId: "mem-tester" }).find((t) => t.name === "bossmode")!;
  const run = async (params: Record<string, unknown>) => {
    const result = (await (gateway.execute as any)("g", params)) as { content: Array<{ text: string }> };
    return result.content[0].text;
  };

  it("list names every gateway capability", async () => {
    const text = await run({ action: "list" });
    for (const name of ["chat_info", "chat_create", "chat_edit", "member_list", "member_info", "profile_read", "profile_update"]) {
      expect(text).toContain(name);
    }
  });

  it("describe returns the description, full parameter schema and a call example", async () => {
    const text = await run({ action: "describe", tool: "member_info" });
    expect(text).toContain("member_info");
    expect(text).toContain('"member"');
    expect(text).toContain('"action":"call"');
    expect(text).toContain('"tool":"member_info"');
  });

  it("unknown tool / missing args return qm-style guidance instead of throwing", async () => {
    const unknown = await run({ action: "call", tool: "member_qury", args: {} });
    expect(unknown).toContain('[error] unknown tool "member_qury"');
    expect(unknown).toContain("member_list");
    const missing = await run({ action: "call", tool: "member_info", args: {} });
    expect(missing).toContain('the "member_info" tool requires');
    expect(missing).toContain("`member`");
    const badArgs = await run({ action: "call", tool: "member_info", args: "not-an-object" });
    expect(badArgs).toContain('"args" must be an object');
  });

  it("call routes through the dispatcher and surfaces execution errors as thrown", async () => {
    await expect((gateway.execute as any)("g", { action: "call", tool: "member_info", args: { member: "qa" } }))
      .rejects.toThrow("boom: explicit error");
    expect(handleToolCallback).toHaveBeenCalledWith(
      "member_info",
      "r1",
      "mem-tester",
      { member: "qa" },
      expect.objectContaining({ memberId: "mem-tester" }),
    );
  });
});
