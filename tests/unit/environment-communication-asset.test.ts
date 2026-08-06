/**
 * Environment & Communication global asset (0.20 experience ③, fish 2026-08-05).
 * Discipline: product default lives in code; a user file is materialized ONLY
 * on edit; upgrades never overwrite an existing user file; restore default =
 * delete the user file. Compile splices the asset into both room and DM Core.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AgentMemberConfig, Room } from "../../src/shared/types.js";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-ec-asset-"));
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
  };
}

const agentDef: AgentDefinition = { name: "qa", description: "QA", systemPrompt: "QA ROLE", tags: [] };
const member: AgentMemberConfig = { id: "rm_qa", name: "qa", sourceAgent: "qa" };

describe("environment-communication asset", () => {
  it("default source returns the product default; no user file materialized", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    const a = asset.getEnvironmentCommunicationAsset();
    expect(a.source).toBe("default");
    expect(a.content).toContain("A colleague, not a system");
    expect(a.content).toContain("No AI-slop phrasing");
    expect(existsSync(join(tmpDir, "prompt-assets", "environment-communication.md"))).toBe(false);
  });

  it("default wording is one-sentence-per-line (no hard-wrapped continuation lines)", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    const content = asset.DEFAULT_ENVIRONMENT_COMMUNICATION;
    const lines = content.split("\n");
    // No indented continuation lines (fish 2026-08-06: hard wraps broke sentences).
    expect(lines.filter((l) => /^ {2,}/.test(l))).toEqual([]);
    // Exactly the 8 communication items, each on its own line.
    expect(lines.filter((l) => /^[0-9]\./.test(l))).toHaveLength(8);
    // Content words unchanged (only line layout differs from the original draft).
    expect(content).toContain("Never \"see above\"");
    expect(content).toContain("Plain IS the right voice in technical work");
  });

  it("save materializes a user file and makes it authoritative; reset restores default", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    const saved = asset.saveEnvironmentCommunication("## Environment\n\nCustom framing.\n");
    expect(saved.source).toBe("user");
    expect(existsSync(join(tmpDir, "prompt-assets", "environment-communication.md"))).toBe(true);

    // Authoritative once edited.
    const after = asset.getEnvironmentCommunicationAsset();
    expect(after.source).toBe("user");
    expect(after.content).toBe("## Environment\n\nCustom framing.\n");
    expect(after.content).not.toContain("A colleague, not a system");

    // Reset deletes the user file → back to product default.
    const reset = asset.resetEnvironmentCommunication();
    expect(reset.source).toBe("default");
    expect(reset.content).toContain("A colleague, not a system");
    expect(existsSync(join(tmpDir, "prompt-assets", "environment-communication.md"))).toBe(false);
  });

  it("empty content is rejected on save", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    expect(() => asset.saveEnvironmentCommunication("   ")).toThrow(/cannot be empty/);
  });

  it("compile splices the product default into room prompts (section + text, after Core)", async () => {
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    const ids = compiled.sections.map((s) => s.id);
    expect(ids).toContain("environment-communication");
    expect(compiled.fullPrompt).toContain("A colleague, not a system");
    const coreIdx = compiled.fullPrompt.indexOf("## Communication");
    const ecIdx = compiled.fullPrompt.indexOf("A colleague, not a system");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(ecIdx);
  });

  it("compile uses the user-edited content when a user file exists", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    asset.saveEnvironmentCommunication("## Environment\n\nCustom framing.\n");
    vi.resetModules();
    const { compileMemberPrompt } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPrompt({ room: room(), member, agentDef, docsRoot: "/docs" });
    expect(compiled.fullPrompt).toContain("Custom framing.");
    expect(compiled.fullPrompt).not.toContain("A colleague, not a system");
  });

  it("compile splices the asset into the DM Core variant too (shared section)", async () => {
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPromptForScope({
      scopeId: "dm:rm_qa",
      memberId: "rm_qa",
      memberName: "qa",
      agentDef,
      room: null,
      docsRoot: "/docs",
    });
    const ids = compiled.sections.map((s) => s.id);
    expect(ids).toContain("environment-communication");
    expect(compiled.fullPrompt).toContain("A colleague, not a system");
    // E&C sits after the DM Core's own Communication section.
    const coreIdx = compiled.fullPrompt.indexOf("Speak with the `response` tool");
    const ecIdx = compiled.fullPrompt.indexOf("A colleague, not a system");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(ecIdx);
  });
});
