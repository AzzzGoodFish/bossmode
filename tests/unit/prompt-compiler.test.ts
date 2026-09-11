import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMemberConfig, Room } from "../../src/shared/types.js";

let fixture: ReturnType<typeof coreFixture>;

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  fixture = coreFixture();
  tmpDir = fixture.root;
  for (const m of room().roomMembers!) {
    new MembersRepository(fixture.db).insert({ id: m.id, name: m.name, agentTemplate: m.sourceAgent,
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
    new ConversationsRepository(fixture.db).ensureDmScope(m.id);
  }
  new ConversationsRepository(fixture.db).upsertRoom(room());
  mkdirSync(join(tmpDir, "members", "mem_qa"), { recursive: true });
});

afterEach(() => {
  fixture.close();
});

function room(): Room {
  return {
    id: "room-a",
    name: "Prompt Lab",
    cwd: "/tmp/project",
    members: ["pm", "qa"],
    globalMemberIds: ["mem_pm", "mem_qa"],
    promptLeaderMemberId: "mem_pm",
    docsPath: "bossmode/",
    roomMembers: [
      { id: "mem_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 },
      { id: "mem_qa", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
    ruleDocs: ["bossmode/rules/old.md"],
  };
}

const member: AgentMemberConfig = { id: "mem_qa", name: "qa", type: "agent", agent: "qa", runtime: "pi-cli", thinkingLevel: "off" };

describe("prompt compiler (four-segment)", () => {
  it("assembles Member → Working Principles → Communication → Environment in order", async () => {
    const { writeMemberProfileSkeleton } = await import("../../src/workspace/member-profile.js");
    writeMemberProfileSkeleton("mem_qa");
    writeFileSync(
      join(tmpDir, "members", "mem_qa", "persona.md"),
      "---\nname: qa\n---\n\nI prefer short answers.\n",
      "utf-8",
    );

    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    const prompt = compiled.fullPrompt;

    expect(compiled.sections.map((s) => s.id)).toEqual(["member", "working-principles", "communication", "environment"]);
    expect(prompt.indexOf("# Member")).toBeLessThan(prompt.indexOf("## Working Principles"));
    expect(prompt.indexOf("## Working Principles")).toBeLessThan(prompt.indexOf("## Communication"));
    expect(prompt.indexOf("## Communication")).toBeLessThan(prompt.indexOf("## Environment"));
    expect(prompt).toContain("I am qa.");
    expect(prompt).toContain("I prefer short answers.");
    expect(prompt).toContain("The chat tool is the only way your messages reach the room");
    // Final-text fallback retired (2026-09-11): no auto-delivery safety net is promised.
    expect(prompt).not.toContain("safety net");
    expect(prompt).toContain("Nothing else is delivered");
    expect(prompt).toContain('You are in room "Prompt Lab"');
    expect(prompt).toContain("this file IS your persona");
    // 2026-09-11 restructure: context-first, user precedence, no acknowledgement loops, no ! interrupt.
    expect(prompt).toContain("precedence over conflicting member requests");
    expect(prompt).toContain("reply only if you add something");
    expect(prompt).not.toContain("!name");
    expect(prompt).not.toContain("urgent interrupt");
    // Old assets not injected
    expect(prompt).not.toContain("## Scope Principles");
    expect(prompt).not.toContain("## Scope Mainline");
    expect(prompt).not.toContain("## Room Principles");
    // Historical-template independence is exercised with real catalog/body damage
    // in core-no-template-runtime.test.ts rather than an unused compiler argument.
  });

  it("birth state: no persona.md → I am <name> only; platform guide present; no archive line", async () => {
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    expect(compiled.fullPrompt).toContain("I am qa.");
    // Platform bossmode-guide is always catalogued; member skills/ may still be empty of private skills.
    expect(compiled.fullPrompt).toMatch(/bossmode-guide/);
    expect(compiled.fullPrompt).toMatch(/when unsure how to manage identity/);
    expect(compiled.fullPrompt).not.toMatch(/Legacy notes/);
  });

  it("DM first line variant", async () => {
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const dm = compileMemberPromptForScope({
      scopeId: "dm:mem_qa",
      memberId: "mem_qa",
      memberName: "qa",
      docsRoot: "/docs",
    });
    expect(dm.fullPrompt).toContain("You are in a private chat with the user.");
    expect(dm.fullPrompt).not.toContain("shared workspace");
  });

  it("persona is literal Markdown; identity comes only from the current member name", async () => {
    const raw = "---\nname: DisplayQA\ntitle: Tester\ndescription: finds bugs\n---\n\nBody only.\n";
    writeFileSync(join(tmpDir, "members", "mem_qa", "persona.md"), raw, "utf-8");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    const section = compiled.sections.find((s) => s.id === "member")!.content;
    expect(section).toBe(`# Member\n\nI am qa.\n\n${raw.trim()}`);
    expect(compiled.fullPrompt).not.toContain("I am DisplayQA.");
  });

  it.each([
    ["\nBody only.\n", "Body only."],
    [" \t\r\n# Title\r\n\r\n  Indented body.\r\n\t ", "# Title\r\n\r\n  Indented body."],
    ["\uFEFF\n---\nname: not-identity\n---\n\nLiteral Markdown.\n", "---\nname: not-identity\n---\n\nLiteral Markdown."],
    [" \t\r\n\uFEFF", ""],
    ["", ""],
  ])("normalizes only the prompt boundary across room and DM (%j)", async (raw, body) => {
    const path = join(tmpDir, "members", "mem_qa", "persona.md");
    writeFileSync(path, raw, "utf-8");
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const { readMemberProfile } = await import("../../src/workspace/member-profile.js");
    const expected = `# Member\n\nI am qa.${body ? `\n\n${body}` : ""}`;
    for (const scopeId of ["room:room-a", "dm:mem_qa"] as const) {
      const compiled = compileMemberPromptForScope({
        scopeId, memberId: "mem_qa", memberName: "qa",
        ...(scopeId.startsWith("dm:") ? {} : { room: room() }), docsRoot: "/docs",
      });
      expect(Buffer.from(compiled.sections.find((s) => s.id === "member")!.content)).toEqual(Buffer.from(expected));
    }
    // Reads and compilation do not trim or otherwise rewrite the file.
    expect(readMemberProfile("mem_qa").body).toBe(raw);
    expect(readMemberProfile("mem_qa").raw).toBe(raw);
    expect(readFileSync(path, "utf-8")).toBe(raw);
  });

  it("marks profileOverBudget when persona.md exceeds 4000 chars without truncating", async () => {
    const body = "x".repeat(4500);
    writeFileSync(join(tmpDir, "members", "mem_qa", "persona.md"), `---\nname: qa\n---\n\n${body}\n`, "utf-8");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    expect(compiled.profileOverBudget).toBe(true);
    expect(compiled.fullPrompt).toContain("x".repeat(4500));
  });

  it("shows archive line only when archive is non-empty", async () => {
    mkdirSync(join(tmpDir, "members", "mem_qa", "archive"), { recursive: true });
    writeFileSync(join(tmpDir, "members", "mem_qa", "archive", "old.md"), "legacy", "utf-8");
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const withArch = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    expect(withArch.fullPrompt).toContain("Legacy notes from the old system");
    expect(withArch.fullPrompt).toContain(join(tmpDir, "members", "mem_qa", "archive"));
  });
});
