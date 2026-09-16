import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * 0.20 WS-B foundation: scope-aware prompt assembly + instanceKey rekey.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let fixture: ReturnType<typeof coreFixture>;
let dir: string;

vi.mock("../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

describe("020 WS-B prompt + instanceKey", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
  });

  afterEach(() => {
    fixture.close();
  });

  it("instanceKey is member-only (one runtime per member, ① B1)", async () => {
    const { scopeIdOf, instanceKey } = await import("../../src/shared/conversation-ref.js");
    const scope = scopeIdOf({ kind: "room", roomId: "abc" });
    expect(scope).toBe("room:abc");
    expect(instanceKey("mem_x")).toBe("mem_x");
  });

  it("compileMemberPrompt (② batch 2) is Persona → Environment → Communication → Memory → Workspace → Assets", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const { compileMemberPrompt } = await import("../../src/agent/prompt/prompt-compiler.js");

    const member = reg.createMember({ name: "architect", agentTemplate: "architect" });
    // Grow persona body beyond birth skeleton.
    writeFileSync(
      join(dir, "members", member.id, "persona.md"),
      "---\nname: architect\n---\n\nI am careful.\n",
      "utf-8",
    );

    const compiled = compileMemberPrompt({ memberId: member.id, memberName: "architect" });

    const ids = compiled.sections.filter((s) => s.included).map((s) => s.id);
    expect(ids).toEqual(["persona", "environment", "communication", "memory", "workspace", "assets"]);
    // One prompt per member: no room / DM lines, no scope markers.
    expect(compiled.envPrompt).not.toContain("room \"");
    expect(compiled.envPrompt).not.toContain("private chat");
    expect(compiled.fullPrompt).toContain("chat_send is the only channel");
    expect(compiled.fullPrompt).not.toContain("[room]");
    expect(compiled.fullPrompt).toContain("I am careful.");
    // Old assets no longer injected (batch 1).
    expect(compiled.fullPrompt).not.toContain("## Scope Principles");
    expect(compiled.fullPrompt).not.toContain("## Room Principles");
  });

  it("compileMemberPrompt (dm-side member) shares one scope-free prompt", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const { compileMemberPrompt } = await import("../../src/agent/prompt/prompt-compiler.js");

    const member = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const compiled = compileMemberPrompt({ memberId: member.id, memberName: "pm" });

    expect(compiled.envPrompt).toContain("- You are pm (");
    expect(compiled.envPrompt).not.toContain("private chat");
    expect(compiled.fullPrompt).toMatch(/In a DM you don't need @/);
    expect(compiled.fullPrompt).not.toContain("[room]");
    expect(compiled.sections.map((s) => s.id)).toEqual(["persona", "environment", "communication", "memory", "workspace", "assets"]);
  });

  it("tool surface: dm has chat_create family; wait family retired", async () => {
    const { toolSurfaceForScope, familyEnabled } = await import("../../src/agent/tools/scope-tool-surface.js");
    const dm = toolSurfaceForScope("dm:mem_x");
    expect(dm.kind).toBe("dm");
    expect(dm.families).toContain("chat_create");
    expect(dm.families).not.toContain("wait");
    expect(dm.families).not.toContain("memory");

    const room = toolSurfaceForScope("room:r1", { isRoomLeader: false });
    expect(room.families).not.toContain("wait");
    expect(room.families).not.toContain("memory");
    expect(room.families).toContain("chat_edit"); // any member
    expect(room.families).not.toContain("chat_create");
    expect(familyEnabled("room:r1", "chat_edit", { isRoomLeader: false })).toBe(true);
    expect(familyEnabled("room:r1", "chat_edit", { isRoomLeader: true })).toBe(true);
  });

  it("getEffectiveConfig is global-only (unified flags retired, batch-5b)", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({
      name: "dev",
      agentTemplate: "developer",
      model: "global/model",
      credentialId: "cred-g",
      unifiedModel: false,
    });
    reg.patchScopeOverride(member.id, "room:r1", { model: "scope/model", credentialId: "cred-s" });
    const eff = reg.getEffectiveConfig(member.id, "room:r1");
    expect(eff.model).toBe("global/model");
    expect(eff.credentialId).toBe("cred-g");
    expect(eff.sources.model).toBe("global");
  });
});
