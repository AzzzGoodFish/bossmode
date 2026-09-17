/** Retired platform configuration stays inert; member extensions remain discoverable. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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
    const reg = await import("../../src/member/identity.js"), __reg_app_member_actions = await import("../../src/app/member-actions.js");
    __reg_app_member_actions.importMemberRecord(legacy);
    reg.updateMember(mId, { global: { thinkingLevel: "high" } });
    const after = reg.getMember(mId)!;
    expect(after.global).not.toHaveProperty("extensions");
    expect(after.global.thinkingLevel).toBe("high");
    // effective config has no extensions channel either
    const eff = reg.getMemberConfiguration(mId);
    expect(eff).not.toHaveProperty("extensions");
  });
});

describe("self-install recipe (guide): npm package via symlink", () => {
  it("symlinked package with package.json pi.extensions is discovered", async () => {
    const { discoverMemberExtensionEntries } = await import("../../src/agent/runtime/pi-sdk.js");
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
