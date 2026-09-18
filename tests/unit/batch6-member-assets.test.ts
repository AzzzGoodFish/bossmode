/** Member-owned SQL MCP configuration and filesystem loader contracts. */
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const { importMemberRecord } = await import("../../src/app/member-actions.js");
  importMemberRecord({ id, name: id, agentTemplate: "general", unifiedModel: true, unifiedExtensions: true,
    global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
    scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
  const { storeRoom } = await import("../../src/chat/conversations.js");
  storeRoom({ id: "r1", name: "MCP", members: [id], globalMemberIds: [id], createdAt: 1 }, fixture.db);
  mkdirSync(join(dir, "members", id), { recursive: true });
}

describe("SQL member MCP configuration as sole live source", () => {
  it("no member config → scoped config is empty (adapter stays bound)", async () => {
    const { writeMemberScopedMcpConfig } = await import("../../src/member/mcp.js");
    await seedMcpOwner("mem_x");
    const scoped = writeMemberScopedMcpConfig({ roomId: "r1", memberId: "mem_x" });
    const text = readFileSync(scoped.configPath, "utf-8");
    scoped.dispose();
    expect(JSON.parse(text)).toEqual({ mcpServers: {} });
    expect(scoped.serverNames).toEqual([]);
  });

  it("SQL member servers pass through; conflicting legacy file is ignored", async () => {
    const { writeMemberScopedMcpConfig, writeMemberMcpConfig } = await import("../../src/member/mcp.js");
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



describe("member dir asset paths (pi loader join)", () => {
  it("present dirs included, absent dirs empty", async () => {
    const { memberDirLoaderAssetPaths } = await import("../../src/agent/runtime/resources.js");
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
