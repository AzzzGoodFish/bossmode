import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

describe("extension-store", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-ext-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists empty when nothing installed", async () => {
    const mod = await import("../../src/workspace/extension-store.js");
    expect(mod.listInstalledExtensions()).toEqual([]);
    expect(mod.resolveInstalledExtensionPaths()).toEqual([]);
  });

  it("resolves pi.extensions entries from a manually planted package", async () => {
    const mod = await import("../../src/workspace/extension-store.js");
    // Plant a fake installed package without npm
    const root = join(dir, "extensions", "node_modules", "fake-ext");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.ts"), "export default {};\n", "utf-8");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fake-ext",
      version: "1.2.3",
      description: "Fake",
      pi: { extensions: ["./index.ts"], skills: ["./skills"] },
    }), "utf-8");
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(dir, "extensions.json"), JSON.stringify({ packages: ["npm:fake-ext"] }), "utf-8");

    const list = mod.listInstalledExtensions();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("fake-ext");
    expect(list[0].version).toBe("1.2.3");
    expect(list[0].extensionPaths.some((p) => p.endsWith("index.ts"))).toBe(true);
    expect(mod.resolveInstalledExtensionPaths().length).toBe(1);
    expect(mod.resolveInstalledExtensionSkillPaths().some((p) => p.endsWith("skills"))).toBe(true);
  });

  it("uninstall removes package from manifest", async () => {
    const mod = await import("../../src/workspace/extension-store.js");
    const root = join(dir, "extensions", "node_modules", "gone-ext");
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(join(dir, "extensions", "package.json"), JSON.stringify({ name: "bossmode-extensions", private: true, dependencies: {} }), "utf-8");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gone-ext", version: "0.0.1", pi: { extensions: [] } }), "utf-8");
    writeFileSync(join(dir, "extensions.json"), JSON.stringify({ packages: ["npm:gone-ext"] }), "utf-8");

    const result = mod.uninstallExtension("gone-ext");
    expect(result.ok).toBe(true);
    expect(mod.listInstalledExtensions()).toEqual([]);
  });
});
