import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
}));

import {
  scopeIdOf,
  parseScopeId,
  scopeDirName,
  parseScopeDirName,
  instanceKey,
  parseInstanceKey,
} from "../../src/shared/conversation-ref.js";

describe("ConversationRef / ScopeId", () => {
  it("round-trips dm and room refs", () => {
    const dm = scopeIdOf({ kind: "dm", memberId: "mem_abc" });
    expect(dm).toBe("dm:mem_abc");
    expect(parseScopeId(dm)).toEqual({ kind: "dm", memberId: "mem_abc" });

    const room = scopeIdOf({ kind: "room", roomId: "room-uuid-1" });
    expect(room).toBe("room:room-uuid-1");
    expect(parseScopeId(room)).toEqual({ kind: "room", roomId: "room-uuid-1" });
  });

  it("parseScopeId returns null on illegal input", () => {
    expect(parseScopeId("")).toBeNull();
    expect(parseScopeId("foo:bar")).toBeNull();
    expect(parseScopeId("dm:")).toBeNull();
    expect(parseScopeId("room:")).toBeNull();
    expect(parseScopeId("dm:a:b")).toBeNull();
  });

  it("scopeDirName encodes for filesystem (no colon)", () => {
    expect(scopeDirName({ kind: "dm", memberId: "mem_x" })).toBe("dm");
    expect(scopeDirName("dm:mem_x")).toBe("dm");
    expect(scopeDirName({ kind: "room", roomId: "r1" })).toBe("room-r1");
    expect(scopeDirName("room:r1")).toBe("room-r1");
    expect(parseScopeDirName("dm", "mem_x")).toEqual({ kind: "dm", memberId: "mem_x" });
    expect(parseScopeDirName("room-r1", "mem_x")).toEqual({ kind: "room", roomId: "r1" });
  });

  it("instanceKey = scopeId:memberId", () => {
    const k = instanceKey("room:r1", "mem_a");
    expect(k).toBe("room:r1:mem_a");
    expect(parseInstanceKey(k)).toEqual({ scopeId: "room:r1", memberId: "mem_a" });
    expect(parseInstanceKey(instanceKey("dm:mem_a", "mem_a"))).toEqual({
      scopeId: "dm:mem_a",
      memberId: "mem_a",
    });
    expect(parseInstanceKey("bad")).toBeNull();
  });
});

describe("member-registry", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bm-memreg-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("creates unique members, rejects name clash, renames, fires", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const a = reg.createMember({ name: "pm", agentTemplate: "pm", model: "anthropic/claude" });
    expect(a.id).toMatch(/^mem_/);
    expect(a.unifiedModel).toBe(true);
    expect(a.global.model).toBe("anthropic/claude");

    expect(() => reg.createMember({ name: "pm", agentTemplate: "pm" })).toThrow(/taken/i);
    expect(() => reg.createMember({ name: "PM", agentTemplate: "pm" })).toThrow(/taken/i);

    const renamed = reg.renameMember(a.id, "project-pm");
    expect(renamed.name).toBe("project-pm");
    expect(reg.findMemberByName("pm")).toBeNull();
    expect(reg.findMemberByName("project-pm")?.id).toBe(a.id);
    expect(reg.resolveMemberRef("project-pm")?.id).toBe(a.id);
    expect(reg.resolveMemberRef(a.id)?.name).toBe("project-pm");

    const { archived } = reg.fireMember(a.id, { confirm: true });
    expect(archived).toMatch(/^backups\/fired-project-pm-/);
    expect(reg.getMember(a.id)).toBeNull();
    expect(reg.listMembers()).toHaveLength(0);
  });

  it("scopeOverrides store diff-only; effective-config reports sources", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const m = reg.createMember({
      name: "dev",
      agentTemplate: "developer",
      model: "global-model",
      credentialId: "cred-g",
      thinkingLevel: "high",
    });

    // unified on → scope override ignored for model family
    reg.patchScopeOverride(m.id, "room:r1", { model: "scope-model" });
    let eff = reg.getEffectiveConfig(m.id, "room:r1");
    expect(eff.model).toBe("global-model");
    expect(eff.sources.model).toBe("global");

    reg.updateMember(m.id, { unifiedModel: false });
    eff = reg.getEffectiveConfig(m.id, "room:r1");
    expect(eff.model).toBe("scope-model");
    expect(eff.sources.model).toBe("scope");
    expect(eff.credentialId).toBe("cred-g"); // not overridden
    expect(eff.sources.credentialId).toBe("global");

    // clear override field
    reg.patchScopeOverride(m.id, "room:r1", { model: null });
    eff = reg.getEffectiveConfig(m.id, "room:r1");
    expect(eff.model).toBe("global-model");
    expect(eff.sources.model).toBe("global");

    const rec = reg.getMember(m.id)!;
    expect(rec.scopeOverrides["room:r1"]).toBeUndefined();
  });
});

describe("member-memory-store + dm-message-store", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bm-mem-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("writes persona and per-scope layers under member dir", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const mem = await import("../../src/workspace/member-memory-store.js");
    const m = reg.createMember({ name: "qa", agentTemplate: "qa" });
    mem.ensureMemorySkeleton(m.id, "dm:" + m.id);
    mem.writeMemoryLayer(m.id, "persona", "## Persona\nI am qa.\n", { type: "user" }, { reason: "init" });
    mem.writeMemoryLayer(
      m.id,
      "principles",
      "## Rules\nBe thorough.\n",
      { type: "member", memberId: m.id, name: "qa" },
      { scopeId: "dm:" + m.id, reason: "note" },
    );
    const persona = mem.readMemoryLayer(m.id, "persona");
    expect(persona.content).toMatch(/I am qa/);
    const prin = mem.readMemoryLayer(m.id, "principles", "dm:" + m.id);
    expect(prin.content).toMatch(/thorough/);
  });

  it("dm messages append with seq and cursor", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const dm = await import("../../src/workspace/dm-message-store.js");
    const m = reg.createMember({ name: "arch", agentTemplate: "architect" });
    const m1 = dm.addDmMessage(m.id, { sender: "user", content: "hello", mentions: [] });
    const m2 = dm.addDmMessage(m.id, {
      sender: "arch",
      content: "hi",
      mentions: [],
      senderMemberId: m.id,
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(dm.readAllDmMessages(m.id)).toHaveLength(2);
    expect(dm.getDmMessagesSince(m.id, 1)).toHaveLength(1);
    dm.setDmCursor(m.id, { messageId: m2.id, seq: 2 });
    expect(dm.getDmCursor(m.id).seq).toBe(2);
  });
});
