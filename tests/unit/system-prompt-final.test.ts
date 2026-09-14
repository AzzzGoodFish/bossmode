/**
 * Contract test: buildFinalMemberSystemPrompt must be byte-identical to pi's
 * real system-prompt assembly (agent-session → buildSystemPrompt custom-prompt
 * branch). The deep import of pi's private builder is the point — it is the
 * sentinel: if pi changes its format (cwd line, section glue) or moves the
 * file, this test goes red instead of the preview silently lying.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";

// Deep import ON PURPOSE (not exported from the package root): resolved from
// the package's own install location so it tracks workspace hoisting.
// Worktrees share the main repo's node_modules — walk up until found.
function findPiSystemPrompt(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("pi-coding-agent system-prompt.js not found from " + process.cwd());
}
const { buildSystemPrompt: piBuildSystemPrompt } = await import(pathToFileURL(findPiSystemPrompt()).href);

// Plain unit env: no mocked config → readPiBuiltinPromptFlag() is false.
import { buildFinalMemberSystemPrompt } from "../../src/engine/system-prompt-final.js";

function fakeMember(over: Partial<Parameters<typeof buildFinalMemberSystemPrompt>[0]["member"]> = {}) {
  return {
    id: "mem_test",
    name: "tester",
    type: "agent" as const,
    agent: "general",
    runtime: "pi-cli",
    ...over,
  };
}

const baseArgs = {
  scopeId: "room:r1",
  cwd: "/tmp/some-room",
  member: fakeMember(),
  skillPaths: [],
  agentPrompt: "You are tester.",
  appendSystemPrompt: ["Communication segment.", "Environment segment."],
};

/** Feed pi's real builder the same inputs the member session would give it. */
function piAssemble(args: typeof baseArgs, skills: string[] = [], contextFiles: Array<{ path: string; content: string }> = []) {
  return piBuildSystemPrompt({
    cwd: args.cwd,
    skills,
    contextFiles,
    customPrompt: args.agentPrompt.trim(),
    appendSystemPrompt: args.appendSystemPrompt.join("\n\n"),
    selectedTools: ["read"],
  });
}

describe("buildFinalMemberSystemPrompt vs pi buildSystemPrompt", () => {
  it("plain segments + cwd line are byte-identical", () => {
    const ours = buildFinalMemberSystemPrompt(baseArgs)!;
    expect(ours).toBe(piAssemble(baseArgs));
    expect(ours.endsWith(`\nCurrent working directory: /tmp/some-room\n`)).toBe(true);
  });

  it("cwd backslashes normalize like pi", () => {
    const args = { ...baseArgs, cwd: "C:\\work\\room" };
    expect(buildFinalMemberSystemPrompt(args)!).toBe(piAssemble(args));
  });

  it("skills section is byte-identical (member skills via pi loaders)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-sysfinal-"));
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: my-skill\ndescription: Does a thing.\n---\n\nBody.\n`, "utf-8");
    const args = { ...baseArgs, cwd: dir, skillPaths: [skillDir] };
    const agentDir = join(dir, "agent-dir");
    const skills = loadSkills({ cwd: dir, agentDir, skillPaths: [skillDir], includeDefaults: false }).skills;
    expect(skills.length).toBe(1);
    const ours = buildFinalMemberSystemPrompt(args)!;
    expect(ours).toBe(piAssemble(args, skills));
    expect(ours).toContain("<available_skills>");
    expect(ours).toContain("<name>my-skill</name>");
  });

  it("project context (AGENTS.md) section is byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-sysfinal2-"));
    writeFileSync(join(dir, "AGENTS.md"), "Room-local instructions.\n", "utf-8");
    const args = { ...baseArgs, cwd: dir };
    const agentDir = join(dir, "agent-dir");
    const contextFiles = loadProjectContextFiles({ cwd: dir, agentDir });
    expect(contextFiles.length).toBeGreaterThan(0);
    expect(buildFinalMemberSystemPrompt(args)!).toBe(piAssemble(args, [], contextFiles));
  });

});
