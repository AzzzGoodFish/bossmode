import { describe, it, expect } from "vitest";
import { buildAgentPrompt, buildEnvironmentPrompt } from "../src/engine/prompt-assembler.js";
import type { AgentDefinition, KnowledgeEntry } from "../src/shared/types.js";

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
    type: "knowledge",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  it("returns empty agentPrompt when agent systemPrompt is empty", () => {
    const agent = makeAgent("", "general");
    const result = buildAgentPrompt(agent, [], ["general", "pm"]);
    expect(result.agentPrompt).toBe("");
    expect(result.envPrompt).toContain("Room members:");
    expect(result.envPrompt).toContain("general, pm");
    expect(result.fullPrompt).toBe(result.envPrompt);
  });

  it("returns empty agentPrompt when systemPrompt is only whitespace", () => {
    const agent = makeAgent("  \n  ", "general");
    const result = buildAgentPrompt(agent, [], ["general"]);
    expect(result.agentPrompt).toBe("");
  });

  it("returns non-empty agentPrompt for normal agents", () => {
    const agent = makeAgent("You are the PM of this team.", "pm");
    const result = buildAgentPrompt(agent, [], ["pm", "dev"]);
    expect(result.agentPrompt).toContain("You are the PM of this team.");
    expect(result.envPrompt).toContain("Room members:");
    expect(result.fullPrompt).toContain("You are the PM of this team.");
    expect(result.fullPrompt).toContain("Room members:");
  });

  it("includes knowledge titles in agentPrompt when present (on-demand content)", () => {
    const agent = makeAgent("You are the PM.", "pm");
    const entries = [makeEntry("Design Doc", "The system uses React")];
    const result = buildAgentPrompt(agent, entries, ["pm"]);
    // Titles are injected as a lightweight document index
    expect(result.agentPrompt).toContain("Design Doc");
    // Full content is NOT injected (retrieved on-demand via query_knowledge)
    expect(result.agentPrompt).not.toContain("The system uses React");
    expect(result.agentPrompt).toContain("query_knowledge");
  });

  it("empty systemPrompt + knowledge still produces non-empty agentPrompt", () => {
    const agent = makeAgent("", "general");
    const entries = [makeEntry("Design Doc", "The system uses React")];
    const result = buildAgentPrompt(agent, entries, ["general"]);
    // Knowledge goes in agentPrompt even if L1 is empty
    expect(result.agentPrompt).toContain("Design Doc");
  });

  it("envPrompt always contains communication rules", () => {
    const agent = makeAgent("", "general");
    const result = buildAgentPrompt(agent, [], ["general"]);
    expect(result.envPrompt).toContain("Available Tools");
    expect(result.envPrompt).toContain("Communication Rules");
    expect(result.envPrompt).toContain("chat");
  });

  it("fullPrompt equals agentPrompt + envPrompt when agentPrompt is non-empty", () => {
    const agent = makeAgent("You are the PM.", "pm");
    const result = buildAgentPrompt(agent, [], ["pm"]);
    expect(result.fullPrompt).toBe(result.agentPrompt + "\n" + result.envPrompt);
  });
});

describe("General Agent: builtin tag template (G1)", () => {
  it("general.md template has builtin tag and empty body", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const content = readFileSync(join(import.meta.dirname, "../templates/agents/general.md"), "utf-8");

    // Has frontmatter with builtin tag
    expect(content).toContain("tags:");
    expect(content).toContain("builtin");
    expect(content).toContain("name: general");

    // Body after frontmatter should be empty
    const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    expect(match).not.toBeNull();
    const body = match![1].trim();
    expect(body).toBe("");
  });
});
