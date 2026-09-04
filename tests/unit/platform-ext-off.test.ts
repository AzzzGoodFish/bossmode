/**
 * Batch 7 closeout (fish 2026-09-04): platform extension loading is retired.
 * — ~/.bossmode/extensions.json archived at startup, idempotently
 * — no platform store anywhere (API 404s, member config has no extensions field)
 * — writeRecord peels global.extensions from legacy member records
 * — the guide's self-install symlink recipe is mechanically valid
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

function seed() {
  dir = mkdtempSync(join(tmpdir(), "bm-plat-ext-off-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
}

beforeEach(seed);
afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("platform extensions.json retirement", () => {
  it("startup archives the manifest once, silently on later runs", async () => {
    seed();
    writeFileSync(join(dir, "extensions.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }), "utf-8");
    const { runMemberAssetsMigrationOnStartup } = await import("../../src/workspace/member-assets-migration.js");
    runMemberAssetsMigrationOnStartup();
    expect(existsSync(join(dir, "extensions.json"))).toBe(false);
    expect(existsSync(join(dir, "extensions.json.pre-batch7c"))).toBe(true);
    // idempotent second run: archive stays, no crash
    runMemberAssetsMigrationOnStartup();
    expect(existsSync(join(dir, "extensions.json.pre-batch7c"))).toBe(true);
    // fresh installs (no manifest ever) stay silent
    rmSync(join(dir, "extensions.json.pre-batch7c"));
    runMemberAssetsMigrationOnStartup();
    expect(readdirSync(dir).some((e) => e.startsWith("extensions.json"))).toBe(false);
  });

  it("member record write peels legacy global.extensions", async () => {
    seed();
    // Hand-write a legacy record carrying the retired field (hermetic — no
    // module-cache coupling with the server test above).
    const mId = "mem_peel0000000000000000000000";
    const mdir = join(dir, "members", mId);
    mkdirSync(mdir, { recursive: true });
    const memberJson = join(mdir, "member.json");
    const legacy = {
      id: mId,
      name: "peelbot",
      agentTemplate: "pm",
      unifiedModel: true,
      unifiedExtensions: true,
      global: { model: null, credentialId: null, thinkingLevel: null, skills: [], extensions: ["npm:pi-web-access"], mcpServers: [] },
      scopeOverrides: {},
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(memberJson, JSON.stringify(legacy), "utf-8");
    const reg = await import("../../src/workspace/member-registry.js");
    reg.updateMember(mId, { global: { thinkingLevel: "high" } });
    const after = JSON.parse(readFileSync(memberJson, "utf-8"));
    expect(after.global).not.toHaveProperty("extensions");
    expect(after.global.thinkingLevel).toBe("high");
    // effective config has no extensions channel either
    const eff = reg.getEffectiveConfig(mId, "dm:x");
    expect(eff).not.toHaveProperty("extensions");
  });
});

describe("self-install recipe (guide): npm package via symlink", () => {
  it("symlinked package with package.json pi.extensions is discovered", async () => {
    seed();
    const { discoverMemberExtensionEntries } = await import("../../src/engine/runtime/pi-sdk.js");
    const extDir = join(dir, "members", "mem_y", "extensions");
    const pkgDir = join(extDir, "node_modules", "fake-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "main.ts"), "export default () => {};", "utf-8");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-pkg", pi: { extensions: ["main.ts"] } }), "utf-8");
    symlinkSync(join("node_modules", "fake-pkg"), join(extDir, "fake-pkg"));
    const entries = discoverMemberExtensionEntries(extDir);
    expect(entries).toEqual([join(extDir, "fake-pkg", "main.ts")]);
    // node_modules itself is never loaded, the root package.json neither
    expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
  });
});
