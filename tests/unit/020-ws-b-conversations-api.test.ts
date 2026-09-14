import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * 0.20 conversations / scope surface unit checks (no full HTTP stack).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let fixture: ReturnType<typeof coreFixture>;
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
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
  });

  afterEach(() => {
    fixture.close();
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
    expect(dm.families).toEqual(expect.arrayContaining(["chat_create", "member_list"]));
    expect(dm.families).not.toContain("response");
    expect(dm.families).not.toContain("wait");

    const roomMember = toolSurfaceForScope("room:r1", { isRoomLeader: false });
    expect(roomMember.families).not.toContain("wait");
    expect(roomMember.families).not.toContain("chat_create");
    expect(roomMember.families).toContain("chat_edit"); // leader gate retired
    expect(roomMember.families).not.toContain("memory" as any);

    const roomLeader = toolSurfaceForScope("room:r1", { isRoomLeader: true });
    expect(roomLeader.families).toContain("chat_edit");
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

  it("dm-scope compile via compileMemberPromptForScope", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const m = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPromptForScope({
      scopeId: `dm:${m.id}`,
      memberId: m.id,
      memberName: "architect",
      room: null,
      docsRoot: join(dir, "docs"),
    });
    expect(compiled.manifestHash).toBeTruthy();
    expect(compiled.envPrompt).toMatch(/private chat/i);
  });
});
