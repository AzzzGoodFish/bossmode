import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AgentMemberConfig, Room } from "../../src/shared/types.js";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-prompt-compiler-"));
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

function room(): Room {
  return {
    id: "room-a",
    name: "Prompt Lab",
    cwd: "/tmp/project",
    members: ["pm", "qa"],
    promptLeaderMemberId: "rm_pm",
    docsPath: "bossmode/",
    roomMembers: [
      { id: "rm_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 },
      { id: "rm_qa", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
    ruleDocs: ["bossmode/rules/old.md"],
  };
}

const agentDef: AgentDefinition = { name: "qa", description: "QA", systemPrompt: "QA ROLE", tags: [] };
const member: AgentMemberConfig = { id: "rm_qa", name: "qa", type: "agent", agent: "qa", runtime: "pi-cli", thinkingLevel: "off" };

describe("prompt compiler", () => {
  it("includes core and non-empty supplements without docs tree or ruleDocs content", async () => {
    const { writePromptSupplement } = await import("../../src/workspace/prompt-supplement-store.js");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    writePromptSupplement({ roomId: "room-a", scope: "room", content: "Room rule", actor: { type: "member", memberId: "rm_pm" } });
    writePromptSupplement({ roomId: "room-a", scope: "member", memberId: "rm_qa", content: "QA note", actor: { type: "member", memberId: "rm_qa" } });

    const compiled = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(compiled.agentPrompt).toBe("QA ROLE");
    expect(compiled.appendSystemPrompt.join("\n")).toContain("Room rule");
    expect(compiled.appendSystemPrompt.join("\n")).toContain("QA note");
    expect(compiled.fullPrompt).not.toContain("## Documents");
    expect(compiled.fullPrompt).not.toContain("Project documents are available on demand");
    expect(compiled.fullPrompt).not.toContain("Use tasks for tracked work");
    expect(compiled.fullPrompt).not.toContain("Project Documents\n```\ndocs/");
    expect(compiled.fullPrompt).not.toContain("old.md");
  });
});
