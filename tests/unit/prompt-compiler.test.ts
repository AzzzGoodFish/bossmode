import { ensureDmScope, storeRoom } from "../../src/chat/conversations.js";
import { insertMemberIdentity } from "../../src/member/identity.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../../src/kernel/types.js";

let fixture: ReturnType<typeof coreFixture>;

let tmpDir = "";



beforeEach(() => {
  fixture = coreFixture();
  tmpDir = fixture.root;
  for (const m of room().roomMembers!) {
    insertMemberIdentity({ id: m.id, name: m.name, agentTemplate: m.sourceAgent,
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 }, fixture.db);
    ensureDmScope(m.id, fixture.db);
  }
  storeRoom(room(), fixture.db);
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

describe("prompt compiler (prompt v2: Persona → How to work)", () => {
  it("assembles Persona → Environment → Communication → Memory → Workspace → Assets, scope-free", async () => {
    const { writeMemberProfileSkeleton } = await import("../../src/member/profile.js");
    writeMemberProfileSkeleton("mem_qa");
    writeFileSync(
      join(tmpDir, "members", "mem_qa", "persona.md"),
      "---\nname: qa\n---\n\nI prefer short answers.\n",
      "utf-8",
    );

    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const compiled = previewMemberPrompt("mem_qa");
    const prompt = compiled.fullPrompt;

    expect(compiled.sections.map((s) => s.id)).toEqual(["persona", "environment", "communication", "memory", "workspace", "assets"]);
    expect(prompt.indexOf("# Persona")).toBeLessThan(prompt.indexOf("## Environment"));
    expect(prompt.indexOf("## Environment")).toBeLessThan(prompt.indexOf("## Communication"));
    expect(prompt.indexOf("## Communication")).toBeLessThan(prompt.indexOf("## Memory"));
    expect(prompt.indexOf("## Memory")).toBeLessThan(prompt.indexOf("## Workspace"));
    expect(prompt.indexOf("## Workspace")).toBeLessThan(prompt.indexOf("## Assets"));
    expect(prompt).toContain("I am qa, an AI teammate in Bossmode.");
    expect(prompt).toContain("I prefer short answers.");
    // One prompt per member: no room / DM lines survive (C1 de-scope).
    expect(prompt).not.toContain("You are in room");
    expect(prompt).not.toContain("private chat with the user");
    expect(prompt).toContain("You face several chats at once");
    // Communication is code-owned; final-text fallback retired (2026-09-11).
    expect(prompt).toContain("chat_send is the only channel");
    expect(prompt).not.toContain("safety net");
    expect(prompt).toContain("outrank other members' requests");
    expect(prompt).toContain("speak only when you add something");
    expect(prompt).not.toContain("!name");
    expect(prompt).not.toContain("urgent interrupt");
    // Working Principles retired: its content folded into Environment / Memory.
    expect(prompt).not.toContain("## Working Principles");
    // Old assets not injected
    expect(prompt).not.toContain("## Scope Principles");
    expect(prompt).not.toContain("## Scope Mainline");
    expect(prompt).not.toContain("## Room Principles");
  });

  it("birth state: no persona.md → identity only; platform guide present; no archive line", async () => {
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const compiled = previewMemberPrompt("mem_qa");
    expect(compiled.fullPrompt).toContain("I am qa, an AI teammate in Bossmode.");
    // Platform bossmode-guide is always catalogued; member skills/ may still be empty of private skills.
    expect(compiled.fullPrompt).toMatch(/bossmode-guide/);
    expect(compiled.fullPrompt).toMatch(/read it when unsure about identity, memory, or skills/);
    expect(compiled.fullPrompt).not.toMatch(/history migrated from the old system/);
  });

  it("description joins the identity sentence; an empty description is omitted", async () => {
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const { updateMemberIdentity } = await import("../../src/member/identity.js");
    updateMemberIdentity("mem_qa", { title: "Tester of prompts" });
    const withDescription = previewMemberPrompt("mem_qa");
    expect(withDescription.fullPrompt).toContain("I am qa (Tester of prompts), an AI teammate in Bossmode.");
    updateMemberIdentity("mem_qa", { title: "" });
    const without = previewMemberPrompt("mem_qa");
    expect(without.fullPrompt).toContain("I am qa, an AI teammate in Bossmode.");
    expect(without.fullPrompt).not.toContain("I am qa (");
  });

  it("persona is literal Markdown; identity comes only from the current member name", async () => {
    const raw = "---\nname: DisplayQA\ntitle: Tester\ndescription: finds bugs\n---\n\nBody only.\n";
    writeFileSync(join(tmpDir, "members", "mem_qa", "persona.md"), raw, "utf-8");
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const compiled = previewMemberPrompt("mem_qa");
    const section = compiled.sections.find((s) => s.id === "persona")!.content;
    expect(section).toBe(`# Persona\n\nI am qa, an AI teammate in Bossmode.\n\n${raw.trim()}`);
    expect(compiled.fullPrompt).not.toContain("I am DisplayQA.");
  });

  it.each([
    ["\nBody only.\n", "Body only."],
    [" \t\r\n# Title\r\n\r\n  Indented body.\r\n\t ", "# Title\r\n\r\n  Indented body."],
    ["\uFEFF\n---\nname: not-identity\n---\n\nLiteral Markdown.\n", "---\nname: not-identity\n---\n\nLiteral Markdown."],
    [" \t\r\n\uFEFF", ""],
    ["", ""],
  ])("normalizes only the prompt boundary (%j)", async (raw, body) => {
    const path = join(tmpDir, "members", "mem_qa", "persona.md");
    writeFileSync(path, raw, "utf-8");
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const { readMemberProfile } = await import("../../src/member/profile.js");
    const expected = `# Persona\n\nI am qa, an AI teammate in Bossmode.${body ? `\n\n${body}` : ""}`;
    const compiled = previewMemberPrompt("mem_qa");
    expect(Buffer.from(compiled.sections.find((s) => s.id === "persona")!.content)).toEqual(Buffer.from(expected));
    // Reads and compilation do not trim or otherwise rewrite the file.
    expect(readMemberProfile("mem_qa").body).toBe(raw);
    expect(readMemberProfile("mem_qa").raw).toBe(raw);
    expect(readFileSync(path, "utf-8")).toBe(raw);
  });

  it("marks profileOverBudget when persona.md exceeds 4000 chars without truncating", async () => {
    const body = "x".repeat(4500);
    writeFileSync(join(tmpDir, "members", "mem_qa", "persona.md"), `---\nname: qa\n---\n\n${body}\n`, "utf-8");
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const compiled = previewMemberPrompt("mem_qa");
    expect(compiled.profileOverBudget).toBe(true);
    expect(compiled.fullPrompt).toContain("x".repeat(4500));
  });

  it("shows the archive line only when the archive is non-empty", async () => {
    mkdirSync(join(tmpDir, "members", "mem_qa", "archive"), { recursive: true });
    writeFileSync(join(tmpDir, "members", "mem_qa", "archive", "old.md"), "legacy", "utf-8");
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const withArch = previewMemberPrompt("mem_qa");
    expect(withArch.fullPrompt).toContain("history migrated from the old system");
    expect(withArch.fullPrompt).toContain(join(tmpDir, "members", "mem_qa", "archive"));
  });
});
