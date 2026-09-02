/**
 * 0.20 flagship ② — unified member panel scope plumbing (backend half).
 *
 * applyMemberConfigPatch is the single write authority for member config
 * patches: unifiedModel/unifiedExtensions fields go global, everything else
 * lands in the target scope's override — for BOTH room and dm scopes. The
 * members-shaped PATCH route and the room PATCH route delegate here, so a
 * model switch from the DM panel and from the room panel persist identically.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function seedMember(name: string, flags?: { unifiedModel?: boolean; unifiedExtensions?: boolean }) {
  const reg = await import("../../src/workspace/member-registry.js");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`, "utf-8");
  const member = reg.createMember({ name, agentTemplate: name });
  if (flags) reg.updateMember(member.id, flags);
  return { reg, member: reg.getMember(member.id)! };
}

describe("applyMemberConfigPatch — unified write authority", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-panel-scope-"));
    mkdirSync(join(dir, "members"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("unifiedModel member: model/thinking go global, no scope override written", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: true });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "anthropic/claude-x", thinkingLevel: "high" });
    const rec = reg.getMember(member.id)!;
    expect(rec.global.model).toBe("anthropic/claude-x");
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.scopeOverrides[`dm:${member.id}`]).toBeUndefined();
  });

  it("batch-5b: scoped member writes land global (flags ignored)", async () => {
    const { reg, member } = await seedMember("scopedflow", { unifiedModel: false });
    const memberId = member.id;
    reg.applyMemberConfigPatch(memberId, `dm:${memberId}`, { model: "openai/gpt-x", thinkingLevel: "high" });
    const rec = reg.getMember(memberId)!;
    expect(rec.global.model).toBe("openai/gpt-x");
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.scopeOverrides[`dm:${memberId}`]).toBeUndefined();
  });

  it("batch-5b: mixed-flag member writes everything global", async () => {
    const { reg, member } = await seedMember("mixedflow", { unifiedModel: true, unifiedExtensions: false });
    const memberId = member.id;
    reg.applyMemberConfigPatch(memberId, "room:room-1", { model: "m1", mcpServers: ["web"] });
    const rec = reg.getMember(memberId)!;
    expect(rec.global.model).toBe("m1");
    expect(rec.global.mcpServers).toEqual(["web"]);
    expect(rec.scopeOverrides["room:room-1"]).toBeUndefined();
  });

  it("batch-5b: null clears the global field (scope overrides gone)", async () => {
    const { reg, member } = await seedMember("clearflow", { unifiedModel: false });
    const memberId = member.id;
    reg.applyMemberConfigPatch(memberId, `dm:${memberId}`, { model: "m1" });
    reg.applyMemberConfigPatch(memberId, `dm:${memberId}`, { model: null });
    const rec = reg.getMember(memberId)!;
    expect(rec.global.model).toBeNull();
    expect(rec.scopeOverrides[`dm:${memberId}`]).toBeUndefined();
  });

  it("batch-5b: null clear never creates a scope entry", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "m1" });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: null });
    expect(reg.getMember(member.id)!.scopeOverrides[`dm:${member.id}`]).toBeUndefined();
  });

  it("batch-5b: effective config reads the global config (flags ignored)", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.updateMember(member.id, { global: { model: "global-model" } });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "dm-model" });
    const eff = reg.getEffectiveConfig(member.id, `dm:${member.id}`);
    expect(eff.model).toBe("dm-model");
    expect(eff.sources.model).toBe("global");
  });
});
