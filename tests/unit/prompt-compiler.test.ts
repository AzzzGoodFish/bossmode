import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AgentMemberConfig, Room } from "../../src/shared/types.js";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-prompt-compiler-"));
  mkdirSync(join(tmpDir, "rooms", "room-a"), { recursive: true });
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
  it("includes core and non-empty principles without docs tree or ruleDocs content", async () => {
    const { writePrinciples } = await import("../../src/workspace/principles-store.js");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    writePrinciples({ roomId: "room-a", scope: "room", content: "Room rule", actor: { type: "member", memberId: "rm_pm" }, reason: "seed" });
    writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_qa", content: "QA note", actor: { type: "member", memberId: "rm_qa" }, reason: "seed" });

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

  it("injects the three asset sections with new titles and capacity headers", async () => {
    const { writePrinciples } = await import("../../src/workspace/principles-store.js");
    const { writeMainline } = await import("../../src/workspace/mainline-store.js");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    writePrinciples({ roomId: "room-a", scope: "room", content: "Room rules here", actor: { type: "member", memberId: "rm_pm" }, reason: "seed" });
    writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_qa", content: "QA working rules", actor: { type: "member", memberId: "rm_qa" }, reason: "seed" });
    writeMainline({ roomId: "room-a", memberId: "rm_qa", content: "## 焦点\n\n质量理念。\n\n## 动态索引\n\n- task:task-none — 不存在\n", actor: { type: "member", memberId: "rm_qa" }, reason: "kickoff" });

    const compiled = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    const prompt = compiled.fullPrompt;
    expect(prompt).toContain("## Room Principles");
    expect(prompt).toContain("## Member Principles");
    expect(prompt).toContain("## Member Mainline");
    expect(prompt).not.toContain("Supplemental Prompt");
    // Capacity header format per plan: pct% — usage/limit
    expect(prompt).toMatch(/## Room Principles\n\n\d+% — \d+\/8,000\n/);
    expect(prompt).toMatch(/## Member Principles\n\n\d+% — \d+\/4,000\n/);
    expect(prompt).toMatch(/## Member Mainline\n\n\d+% — \d+\/4,000\n/);
    // Section ids renamed + mainline added
    const ids = compiled.sections.map((s) => s.id);
    expect(ids).toEqual(["source-agent", "bossmode-core", "room-principles", "member-principles", "member-mainline"]);
    // Mainline index resolved at injection: dead task marked stale, never deleted
    expect(prompt).toContain("[stale] task:task-none");
  });

  it("core carries the Communication section (chat is the only channel) and no stale footer/chat lines", async () => {
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(compiled.fullPrompt).toContain("## Communication");
    expect(compiled.fullPrompt).toContain("The `chat` tool is the only way to communicate — to the user and to members alike.");
    expect(compiled.fullPrompt).toContain("if it isn't sent through chat, it was never said.");
    expect(compiled.fullPrompt).not.toContain("envelope footer");
    expect(compiled.fullPrompt).not.toContain("Communication goes exclusively through");
  });

  it("mainline section is omitted when empty; stale refs self-heal between compiles", async () => {
    const { writeMainline } = await import("../../src/workspace/mainline-store.js");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const empty = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(empty.fullPrompt).not.toContain("## Member Mainline");
    expect(empty.sections.find((s) => s.id === "member-mainline")?.included).toBe(false);

    writeMainline({ roomId: "room-a", memberId: "rm_qa", content: "## 焦点\n\nF\n\n## 动态索引\n\n- docs/bossmode/later.md — 稍后建\n", actor: { type: "member", memberId: "rm_qa" }, reason: "pin" });
    const stale = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(stale.fullPrompt).toContain("[stale] docs/bossmode/later.md");
    // The doc appears → next compile resolves it (Reload picks this up)
    mkdirSync(join(tmpDir, "knowledge", "docs", "bossmode"), { recursive: true });
    writeFileSync(join(tmpDir, "knowledge", "docs", "bossmode", "later.md"), "x", "utf-8");
    const healed = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(healed.fullPrompt).toContain("- docs/bossmode/later.md — 稍后建");
    expect(healed.fullPrompt).not.toContain("[stale]");
  });
});
