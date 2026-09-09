/**
 * Batch 6 (spec-member-assets-session-rebuild-v1 §5): member-owned assets —
 * mcp.json sole source + migration invariants, member skills/extensions into
 * loader paths, unified buildMemberAgentSession, reload tool semantics.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

function seed() {
  dir = mkdtempSync(join(tmpdir(), "bm-batch6-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "mcp"), { recursive: true });
  vi.resetModules();
}

import { vi, beforeEach, afterEach } from "vitest";

beforeEach(seed);
afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const PLATFORM_MCP = {
  mcpServers: {
    "srv-a": { type: "stdio", command: "npx", args: ["-y", "srv-a"] },
    "srv-b": { type: "stdio", command: "npx", args: ["-y", "srv-b"] },
  },
};

describe("member mcp.json as sole source", () => {
  it("no member file → scoped config is empty (adapter stays bound)", async () => {
    seed();
    const { writeMemberScopedMcpConfig } = await import("../../src/shared/mcp-settings.js");
    mkdirSync(join(dir, "members", "mem_x"), { recursive: true });
    const scoped = writeMemberScopedMcpConfig({ roomId: "r1", memberId: "mem_x" });
    const text = readFileSync(scoped.configPath, "utf-8");
    expect(JSON.parse(text)).toEqual({ mcpServers: {} });
    expect(scoped.serverNames).toEqual([]);
  });

  it("member file servers all pass through (file present = enabled)", async () => {
    seed();
    const { writeMemberScopedMcpConfig } = await import("../../src/shared/mcp-settings.js");
    mkdirSync(join(dir, "members", "mem_y"), { recursive: true });
    writeFileSync(join(dir, "members", "mem_y", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const scoped = writeMemberScopedMcpConfig({ roomId: "r1", memberId: "mem_y" });
    expect(scoped.serverNames.sort()).toEqual(["srv-a", "srv-b"]);
    const text = readFileSync(scoped.configPath, "utf-8");
    expect(Object.keys(JSON.parse(text).mcpServers).sort()).toEqual(["srv-a", "srv-b"]);
  });
});

describe("batch 6 migration (behavior invariants)", () => {
  it("dry-run default: nothing written", async () => {
    seed();
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/workspace/member-registry.js");
    reg.createMember({ name: "listed", agentTemplate: "pm", mcpServers: ["srv-a"] } as any);
    const report = runMemberAssetsMigration(); // dry-run
    expect(report.dryRun).toBe(true);
    expect(report.members.find((m) => m.name === "listed")?.action).toBe("would-create");
    // Nothing written, platform file untouched
    expect(existsSync(join(dir, "mcp", "mcp.json"))).toBe(true);
    const files = existsSync(join(dir, "members")) ? require_fs_readdir(join(dir, "members")) : [];
    for (const f of files) {
      expect(existsSync(join(dir, "members", f, "mcp.json"))).toBe(false);
    }
  });

  it("apply: only enable-listed servers copied; no-list member gets no file", async () => {
    seed();
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/workspace/member-registry.js");
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
    seed();
    writeFileSync(join(dir, "mcp", "mcp.json"), JSON.stringify(PLATFORM_MCP), "utf-8");
    const { runMemberAssetsMigration, needsMemberAssetsMigration } = await import("../../src/workspace/member-assets-migration.js");
    const reg = await import("../../src/workspace/member-registry.js");
    reg.createMember({ name: "solo", agentTemplate: "pm", mcpServers: ["srv-b"] } as any);
    runMemberAssetsMigration({ dryRun: false });
    vi.resetModules();
    expect(needsMemberAssetsMigration()).toBe(false);
    const again = runMemberAssetsMigration({ dryRun: false });
    expect(again.members.length).toBe(0);
  });
});

function require_fs_readdir(p: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs");
  return fs.readdirSync(p);
}

describe("member dir asset paths (pi loader join)", () => {
  it("present dirs included, absent dirs empty", async () => {
    seed();
    const { memberDirLoaderAssetPaths } = await import("../../src/engine/runtime/pi-sdk.js");
    const { memberSkillsDir, memberExtensionsDir } = await import("../../src/workspace/member-profile.js");
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
