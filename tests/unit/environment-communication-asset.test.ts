/**
 * Environment & Communication global asset (0.20 experience ③, fish 2026-08-05).
 * Discipline: product default lives in code; a user file is materialized ONLY
 * on edit; upgrades never overwrite an existing user file; restore default =
 * delete the user file. Current compilation uses code-owned Communication instead.
 */
import { coreFixture } from "../helpers/core-fixture.js";
import { SettingsRepository } from "../../src/storage/repositories/settings.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMemberConfig, Room } from "../../src/shared/types.js";

const tmpDir = process.env.BOSSMODE_DIR!;
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  new SettingsRepository(fixture.db).importConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } });
  new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] });
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

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

  it("identity batch-1: compile no longer injects the E&C asset (Communication is code-owned)", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    asset.saveEnvironmentCommunication("## Environment\n\nCustom framing.\n");
    const { compileMemberPrompt, compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const roomCompiled = compileMemberPrompt({ room: room(), member, docsRoot: "/docs" });
    expect(roomCompiled.sections.map((s) => s.id)).toEqual(["member", "working-principles", "communication", "environment"]);
    expect(roomCompiled.fullPrompt).toContain("The chat tool is the only way your messages reach the room");
    expect(roomCompiled.fullPrompt).not.toContain("Custom framing.");
    expect(roomCompiled.fullPrompt).not.toContain("A colleague, not a system");

    const dmCompiled = compileMemberPromptForScope({
      scopeId: "dm:rm_qa",
      memberId: "rm_qa",
      memberName: "qa",
      room: null,
      docsRoot: "/docs",
    });
    expect(dmCompiled.fullPrompt).toContain("private chat with the user");
    expect(dmCompiled.fullPrompt).not.toContain("Custom framing.");
  });

  it("preserves retained user bytes and falls back on unreadable assets without overwriting them", async () => {
    const asset = await import("../../src/workspace/environment-communication-asset.js");
    const path = join(tmpDir, "prompt-assets", "environment-communication.md");
    mkdirSync(join(tmpDir, "prompt-assets"), { recursive: true });
    const raw = "\uFEFF  Retained framing.\r\n\r\n";
    writeFileSync(path, raw);
    expect(asset.getEnvironmentCommunicationAsset()).toMatchObject({ source: "user", content: raw, updatedAt: expect.any(Number) });
    fixture.reopen();
    expect(readFileSync(path)).toEqual(Buffer.from(raw));
    const { rmSync } = await import("node:fs");
    rmSync(path);
    mkdirSync(path);
    expect(asset.getEnvironmentCommunicationAsset()).toEqual({ source: "default", content: asset.DEFAULT_ENVIRONMENT_COMMUNICATION });
    expect(existsSync(path)).toBe(true);
  });
});
