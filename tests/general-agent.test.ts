import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "../src/agent/prompt/prompt-assembler.js";
import type { AgentDefinition, KnowledgeEntry } from "../src/kernel/types.js";

describe("General Agent: prompt-assembler split (G3)", () => {
  const makeAgent = (systemPrompt: string, name = "test"): AgentDefinition => ({
    name,
    description: "Test agent",
    systemPrompt,
    tags: [],
  });

  const makeEntry = (title: string, content: string): KnowledgeEntry => ({
    id: "e1",
    title,
    content,
    source: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  it("keeps empty agentPrompt empty when agent systemPrompt is empty", () => {
    const agent = makeAgent("", "general");
    const result = buildAgentPrompt(agent, [], ["general", "pm"], "bossmode dev");
    expect(result.agentPrompt).toBe("");
    expect(result.envPrompt).toContain("Room members:");
    expect(result.envPrompt).toContain("general, pm");
    expect(result.fullPrompt).toBe(result.envPrompt);
  });

  it("returns empty agentPrompt when systemPrompt is only whitespace", () => {
    const agent = makeAgent("  \n  ", "general");
    const result = buildAgentPrompt(agent, [], ["general"], "bossmode dev");
    expect(result.agentPrompt).toBe("");
  });

  it("returns non-empty agentPrompt for normal agents", () => {
    const agent = makeAgent("You are the PM of this team.", "pm");
    const result = buildAgentPrompt(agent, [], ["pm", "dev"], "bossmode dev");
    expect(result.agentPrompt).toContain("You are the PM of this team.");
    expect(result.envPrompt).toContain("Room members:");
    expect(result.fullPrompt).toContain("You are the PM of this team.");
    expect(result.fullPrompt).toContain("Room members:");
  });

  it("includes knowledge titles in envPrompt when present (on-demand content)", () => {
    const agent = makeAgent("You are the PM.", "pm");
    const entries = [makeEntry("Design Doc", "The system uses React")];
    const result = buildAgentPrompt(agent, entries, ["pm"], "bossmode dev", undefined, undefined, undefined, "/tmp/test-docs");
    // Titles are injected as a lightweight Bossmode overlay, not as the agent role prompt.
    expect(result.agentPrompt).toBe("You are the PM.");
    expect(result.envPrompt).toContain("Design Doc");
    // Full content is NOT injected (read on-demand via filesystem)
    expect(result.envPrompt).not.toContain("The system uses React");
    expect(result.envPrompt).toContain("Documents are stored at");
  });

  it("member persona plus knowledge keeps Bossmode append prompt", async () => {
    const agent = makeAgent("My current member persona.", "general");
    const entries = [makeEntry("Design Doc", "The system uses React")];
    const result = buildAgentPrompt(agent, entries, ["general"], "bossmode dev");

    expect(result.agentPrompt).toBe("My current member persona.");
    expect(result.envPrompt).toContain("Design Doc");
    expect(result.envPrompt).toContain('group chat room "bossmode dev"');
    expect(result.fullPrompt).toContain(result.agentPrompt);
    expect(result.fullPrompt).toContain(result.envPrompt);
  });

  it("envPrompt uses envelope guidance and no tool/rules sections", () => {
    const agent = makeAgent("", "general");
    const result = buildAgentPrompt(agent, [], ["general"], "bossmode dev");
    expect(result.envPrompt).toContain('group chat room "bossmode dev"');
    expect(result.envPrompt).toContain("wrapped in envelopes");
    expect(result.envPrompt).not.toContain("Available Tools");
    expect(result.envPrompt).not.toContain("Communication Rules");
  });

  it("fullPrompt equals agentPrompt + envPrompt when agentPrompt is non-empty", () => {
    const agent = makeAgent("You are the PM.", "pm");
    const result = buildAgentPrompt(agent, [], ["pm"], "bossmode dev");
    expect(result.fullPrompt).toBe(result.agentPrompt + "\n" + result.envPrompt);
  });
});

describe("historical general template provenance", () => {
  it("retains builtin tags and literal historical body without a bundled live template", async () => {
    const { parseAgentDefinitionMarkdown } = await import("../src/app/upgrade/records.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const body = "Historical general persona.\n  Keep literal bytes.\n";
    const parsed = parseAgentDefinitionMarkdown("general", `---\nname: general\ntags: [builtin]\n---\n${body}`);
    expect(parsed.metadata).toMatchObject({ slug: "general", name: "general", tags: ["builtin"] });
    expect(parsed.body).toBe(body);
    expect(existsSync(join(import.meta.dirname, "../templates/agents/general.md"))).toBe(false);
  });
});
