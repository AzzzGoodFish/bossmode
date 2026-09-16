/**
 * Batch 6 (spec-member-assets-session-rebuild-v1 §5): member-owned assets —
 * mcp.json sole source + migration invariants, member skills/extensions into
 * loader paths, unified buildMemberAgentSession, reload tool semantics.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;

async function seed() {
  dir = process.env.BOSSMODE_DIR!;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "mcp"), { recursive: true });
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
}

import { vi, beforeEach, afterEach } from "vitest";

beforeEach(seed);
afterEach(() => {
  fixture.close();
});

const PLATFORM_MCP = {
  mcpServers: {
    "srv-a": { type: "stdio", command: "npx", args: ["-y", "srv-a"] },
    "srv-b": { type: "stdio", command: "npx", args: ["-y", "srv-b"] },
  },
};

async function seedMcpOwner(id: string) {
  const { importMemberRecord } = await import("../../src/member/member-registry.js");
  importMemberRecord({ id, name: id, agentTemplate: "general", unifiedModel: true, unifiedExtensions: true,
    global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
    scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
  const { ConversationsRepository } = await import("../../src/data/repositories/conversations.js");
  new ConversationsRepository(fixture.db).upsertRoom({ id: "r1", name: "MCP", members: [id], globalMemberIds: [id], createdAt: 1 });
  mkdirSync(join(dir, "members", id), { recursive: true });
}

describe("SQL member MCP configuration as sole live source", () => {
  it("no member config → scoped config is empty (adapter stays bound)", async () => {
    const { writeMemberScopedMcpConfig } = await import("../../src/shared/mcp-settings.js");
    await seedMcpOwner("mem_x");
    const scoped = writeMemberScopedMcpConfig({ roomId: "r1", memberId: "mem_x" });
    const text = readFileSync(scoped.configPath, "utf-8");
    scoped.dispose();
    expect(JSON.parse(text)).toEqual({ mcpServers: {} });
    expect(scoped.serverNames).toEqual([]);
  });

  it("SQL member servers pass through; conflicting legacy file is ignored", async () => {
    const { writeMemberScopedMcpConfig, writeMemberMcpConfig } = await import("../../src/shared/mcp-settings.js");
    await seedMcpOwner("mem_y");
    writeMemberMcpConfig("mem_y", PLATFORM_MCP);
    writeFileSync(join(dir, "members", "mem_y", "mcp.json"), '{"mcpServers":{}}');
    const scoped = writeMemberScopedMcpConfig({ roomId: "r1", memberId: "mem_y" });
    expect(scoped.serverNames.sort()).toEqual(["srv-a", "srv-b"]);
    const text = readFileSync(scoped.configPath, "utf-8");
    scoped.dispose();
    expect(Object.keys(JSON.parse(text).mcpServers).sort()).toEqual(["srv-a", "srv-b"]);
  });
});

describe("batch 6 migration (behavior invariants)", () => {
  it("dry-run default: nothing written", async () => {
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/member/member-registry.js");
    reg.createMember({ name: "listed", agentTemplate: "pm", mcpServers: ["srv-a"] } as any);
    const report = runMemberAssetsMigration(); // dry-run
    expect(report.dryRun).toBe(true);
    expect(report.members.find((m) => m.name === "listed")?.action).toBe("would-create");
    // Nothing written, platform file untouched
    expect(existsSync(join(dir, "mcp", "mcp.json"))).toBe(true);
    const files = existsSync(join(dir, "members")) ? readdirSync(join(dir, "members")) : [];
    for (const f of files) {
      expect(existsSync(join(dir, "members", f, "mcp.json"))).toBe(false);
    }
  });

  it("apply: only enable-listed servers copied; no-list member gets no file", async () => {
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/member/member-registry.js");
    const withList = reg.createMember({ name: "with-list", agentTemplate: "pm", mcpServers: ["srv-a"] } as any);
    const noList = reg.createMember({ name: "no-list", agentTemplate: "pm" });

    const report = runMemberAssetsMigration({ dryRun: false });
    const withListEntry = report.members.find((m) => m.name === "with-list")!;
    expect(withListEntry.action).toBe("created");
    expect(withListEntry.serverCount).toBe(1);
    const copied = JSON.parse(readFileSync(join(dir, "members", withList.id, "mcp.json"), "utf-8"));
    expect(Object.keys(copied.mcpServers)).toEqual(["srv-a"]);

    expect(existsSync(join(dir, "members", noList.id, "mcp.json"))).toBe(false);
    // Platform file archived after apply
    expect(existsSync(join(dir, "mcp", "mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "mcp", "mcp.json.pre-batch6"))).toBe(true);
    expect(report.platformArchived).toBe(true);
  });

  it("rerun after apply is a no-op", async () => {
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration, needsMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/member/member-registry.js");
    reg.createMember({ name: "solo", agentTemplate: "pm", mcpServers: ["srv-b"] } as any);
    runMemberAssetsMigration({ dryRun: false });
    expect(needsMemberAssetsMigration()).toBe(false);
    const again = runMemberAssetsMigration({ dryRun: false });
    expect(again.members.length).toBe(0);
  });
});

describe("member dir asset paths (pi loader join)", () => {
  it("present dirs included, absent dirs empty", async () => {
    const { memberDirLoaderAssetPaths } = await import("../../src/engine/runtime/pi-sdk.js");
    const { memberSkillsDir, memberExtensionsDir } = await import("../../src/files/layout.js");
    // absent → empty
    expect(memberDirLoaderAssetPaths("mem_none")).toEqual({ skills: [], extensions: [] });
    // present → skills dir as-is; extensions dir expanded into file entries
    // (qa rc.14 ①: pi's loader takes module files, not directories).
    mkdirSync(memberSkillsDir("mem_has"), { recursive: true });
    const extDir = memberExtensionsDir("mem_has");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "a-tool.ts"), "export default () => {};\n", "utf-8");
    const got = memberDirLoaderAssetPaths("mem_has");
    expect(got.skills).toEqual([memberSkillsDir("mem_has")]);
    expect(got.extensions).toEqual([join(extDir, "a-tool.ts")]);
  });
});
