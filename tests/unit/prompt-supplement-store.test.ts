import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-prompt-supp-"));
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("prompt-supplement-store", () => {
  it("returns empty revision 0 for missing supplements", async () => {
    const { readPromptSupplement } = await import("../../src/workspace/prompt-supplement-store.js");
    const result = readPromptSupplement("room-a", "member", "rm_1");
    expect(result.content).toBe("");
    expect(result.revision).toBe(0);
  });

  it("writes metadata and increments revision", async () => {
    const { writePromptSupplement, readPromptSupplement } = await import("../../src/workspace/prompt-supplement-store.js");
    const saved = writePromptSupplement({ roomId: "room-a", scope: "room", content: "## Rules\n- One", actor: { type: "member", memberId: "rm_1", name: "pm" } });
    expect(saved.revision).toBe(1);
    expect(saved.contentLength).toBe(saved.content.length);
    const read = readPromptSupplement("room-a", "room");
    expect(read.content).toContain("One");
    expect(read.updatedByMemberId).toBe("rm_1");
  });

  it("edits exactly one match", async () => {
    const { writePromptSupplement, editPromptSupplement } = await import("../../src/workspace/prompt-supplement-store.js");
    writePromptSupplement({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "alpha beta", actor: { type: "member", memberId: "rm_1" } });
    const edited = editPromptSupplement({ roomId: "room-a", scope: "member", memberId: "rm_1", oldText: "beta", newText: "gamma", actor: { type: "member", memberId: "rm_1" } });
    expect(edited.content).toBe("alpha gamma");
    expect(edited.revision).toBe(2);
  });

  it("rejects zero, multiple, and oversized edits", async () => {
    const { writePromptSupplement, editPromptSupplement, PROMPT_SUPPLEMENT_MAX_CHARS } = await import("../../src/workspace/prompt-supplement-store.js");
    writePromptSupplement({ roomId: "room-a", scope: "room", content: "x x", actor: { type: "member" } });
    expect(() => editPromptSupplement({ roomId: "room-a", scope: "room", oldText: "z", newText: "a", actor: { type: "member" } })).toThrow(/not found/);
    expect(() => editPromptSupplement({ roomId: "room-a", scope: "room", oldText: "x", newText: "a", actor: { type: "member" } })).toThrow(/multiple/);
    expect(() => writePromptSupplement({ roomId: "room-a", scope: "room", content: "x".repeat(PROMPT_SUPPLEMENT_MAX_CHARS + 1), actor: { type: "member" } })).toThrow(/too large/);
  });
});
