/**
 * Batch 7 closeout (fish 2026-09-04): platform extension loading is retired.
 * — ~/.bossmode/extensions.json archived at startup, idempotently
 * — no platform store anywhere (API 404s, member config has no extensions field)
 * — writeRecord peels global.extensions from legacy member records
 * — the guide's self-install symlink recipe is mechanically valid
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;

async function seed() {
  dir = process.env.BOSSMODE_DIR!;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
}

beforeEach(seed);
afterEach(() => {
  fixture.close();
});

describe("platform extensions.json retirement", () => {
  it("startup archives the manifest once, silently on later runs", async () => {
    writeFileSync(join(dir, "extensions.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }), "utf-8");
    const { runMemberAssetsMigrationOnStartup } = await import("../../src/member/migrations/member-assets-migration.js");
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
    // Hand-write a legacy record carrying the retired field (hermetic — no
    // module-cache coupling with the server test above).
    const mId = "mem_peel0000000000000000000000";
    const mdir = join(dir, "members", mId);
    mkdirSync(mdir, { recursive: true });
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
    const reg = await import("../../src/member/member-registry.js");
    reg.importMemberRecord(legacy);
    reg.updateMember(mId, { global: { thinkingLevel: "high" } });
    const after = reg.getMember(mId)!;
    expect(after.global).not.toHaveProperty("extensions");
    expect(after.global.thinkingLevel).toBe("high");
    // effective config has no extensions channel either
    const eff = reg.getEffectiveConfig(mId, "dm:x");
    expect(eff).not.toHaveProperty("extensions");
  });
});

describe("self-install recipe (guide): npm package via symlink", () => {
  it("symlinked package with package.json pi.extensions is discovered", async () => {
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
