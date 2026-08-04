/**
 * 0.20 conversations / scope surface unit checks (no full HTTP stack).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

describe("020 conversations / scope surface", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-conv-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("conversations module loads and registers routes", async () => {
    // Importing registers addRoute handlers; smoke that no throw.
    await import("../../src/api/conversations.js");
    expect(true).toBe(true);
  });

  it("tools endpoint data sources: surface + families", async () => {
    const { toolSurfaceForScope } = await import("../../src/engine/scope-tool-surface.js");
    const dm = toolSurfaceForScope("dm:mem_x");
    expect(dm.kind).toBe("dm");
    expect(dm.families).toEqual(expect.arrayContaining(["create_room", "list_members", "chat"]));
    expect(dm.families).not.toContain("wait");

    const roomMember = toolSurfaceForScope("room:r1", { isRoomLeader: false });
    expect(roomMember.families).toContain("wait");
    expect(roomMember.families).not.toContain("create_room");
    expect(roomMember.families).not.toContain("edit_room");

    const roomLeader = toolSurfaceForScope("room:r1", { isRoomLeader: true });
    expect(roomLeader.families).toContain("edit_room");
  });

  it("effective-config binds into memberRecordToConfig path via getEffectiveConfig", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const m = reg.createMember({
      name: "pm",
      agentTemplate: "pm",
      model: "provider/model-a",
      credentialId: "cred-a",
      unifiedModel: true,
    });
    const eff = reg.getEffectiveConfig(m.id, `dm:${m.id}`);
    expect(eff.model).toBe("provider/model-a");
    expect(eff.credentialId).toBe("cred-a");
    expect(eff.sources.model).toBe("global");
  });

  it("core-prompt dm compile for members/:id/core-prompt contract", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const m = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPromptForScope({
      scopeId: `dm:${m.id}`,
      memberId: m.id,
      memberName: "architect",
      agentDef: { name: "architect", description: "", systemPrompt: "You are architect.", tags: [], skills: [] },
      room: null,
      docsRoot: join(dir, "docs"),
    });
    expect(compiled.manifestHash).toBeTruthy();
    expect(compiled.envPrompt).toMatch(/private chat/i);
  });
});
