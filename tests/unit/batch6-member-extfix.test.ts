/** Member extension discovery supplies module files, never bare directories. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;
beforeEach(async () => {
  dir = process.env.BOSSMODE_DIR!;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "mcp"), { recursive: true });
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
});
afterEach(() => {
  fixture.close();
});

describe("discoverMemberExtensionEntries (qa ①)", () => {
  it("root-level .ts/.js files, subdirectory index.ts, and package.json manifests all become file entries", async () => {
    const { memberDirLoaderAssetPaths, discoverMemberExtensionEntries } = await import("../../src/agent/runtime/resources.js");
    const { memberExtensionsDir } = await import("../../src/files/layout.js");
    const extDir = memberExtensionsDir("mem_a");
    mkdirSync(extDir, { recursive: true });

    // 1. root-level file
    writeFileSync(join(extDir, "root-tool.ts"), "export default () => {};\n", "utf-8");
    // 2. subdir with index.ts
    mkdirSync(join(extDir, "indexed"));
    writeFileSync(join(extDir, "indexed", "index.ts"), "export default () => {};\n", "utf-8");
    // 3. subdir with package.json pi manifest
    mkdirSync(join(extDir, "manifested"));
    writeFileSync(join(extDir, "manifested", "package.json"), JSON.stringify({ pi: { extensions: ["src/main.ts"] } }), "utf-8");
    mkdirSync(join(extDir, "manifested", "src"));
    writeFileSync(join(extDir, "manifested", "src", "main.ts"), "export default () => {};\n", "utf-8");
    // noise: dotfile + non-source + entryless dir
    writeFileSync(join(extDir, ".hidden.ts"), "export default () => {};\n", "utf-8");
    writeFileSync(join(extDir, "notes.md"), "x", "utf-8");
    mkdirSync(join(extDir, "empty"));

    const entries = discoverMemberExtensionEntries(extDir);
    expect(entries).toContain(join(extDir, "root-tool.ts"));
    expect(entries).toContain(join(extDir, "indexed", "index.ts"));
    expect(entries).toContain(join(extDir, "manifested", "src", "main.ts"));
    expect(entries).toHaveLength(3);
    expect(entries.every((p) => /\.(ts|js)$/.test(p))).toBe(true);

    // the loader-facing helper now hands pi FILE entries, never the bare dir
    const assets = memberDirLoaderAssetPaths("mem_a");
    expect(assets.extensions).toEqual(entries);
  });

  it("absent dir → empty; loader never receives the bare directory path", async () => {
    const { memberDirLoaderAssetPaths } = await import("../../src/agent/runtime/resources.js");
    const assets = memberDirLoaderAssetPaths("mem_none");
    expect(assets.extensions).toEqual([]);
    expect(assets.skills).toEqual([]);
  });
});
