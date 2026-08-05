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

  it("scope-overriding member: model/thinking land in the dm scope override", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "openai/gpt-x", thinkingLevel: "low" });
    const rec = reg.getMember(member.id)!;
    expect(rec.scopeOverrides[`dm:${member.id}`]).toEqual({ model: "openai/gpt-x", thinkingLevel: "low" });
    expect(rec.global.model ?? null).toBeNull();
  });

  it("mixed member splits across both writes (model global, mcp scope)", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: true, unifiedExtensions: false });
    reg.applyMemberConfigPatch(member.id, "room:room-1", { model: "m1", mcpServers: ["web"] });
    const rec = reg.getMember(member.id)!;
    expect(rec.global.model).toBe("m1");
    expect(rec.scopeOverrides["room:room-1"]).toEqual({ mcpServers: ["web"] });
  });

  it("null clears a scope override field (falls back to global)", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "m1", thinkingLevel: "high" });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { thinkingLevel: null });
    const rec = reg.getMember(member.id)!;
    expect(rec.scopeOverrides[`dm:${member.id}`]).toEqual({ model: "m1" });
  });

  it("clearing the last override field removes the scope entry entirely", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "m1" });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: null });
    expect(reg.getMember(member.id)!.scopeOverrides[`dm:${member.id}`]).toBeUndefined();
  });

  it("effective config reads the dm scope override", async () => {
    const { reg, member } = await seedMember("dev", { unifiedModel: false });
    reg.updateMember(member.id, { global: { model: "global-model" } });
    reg.applyMemberConfigPatch(member.id, `dm:${member.id}`, { model: "dm-model" });
    const eff = reg.getEffectiveConfig(member.id, `dm:${member.id}`);
    expect(eff.model).toBe("dm-model");
  });
});
