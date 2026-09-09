import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMemberExtensions, discoverMemberExtensionEntries } from "../../src/workspace/member-extensions.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bm-ext-inventory-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function file(path: string, content = "throw new Error('Discovery must never execute extensions');") {
  writeFileSync(path, content);
}
function pkg(dir: string, manifest: unknown) {
  mkdirSync(dir, { recursive: true });
  file(join(dir, "package.json"), JSON.stringify(manifest));
}

describe("member extension inventory", () => {
  it("uses package names, keeps symlink and target paths, groups multiple entries without executing", () => {
    const target = join(root, "node_modules", "actual");
    pkg(target, { name: "@scope/actual", pi: { extensions: ["a.ts", "b.js"] } });
    file(join(target, "a.ts")); file(join(target, "b.js"));
    const alias = join(root, "alias");
    symlinkSync(target, alias);
    expect(discoverMemberExtensions(root)).toEqual([{
      name: "@scope/actual", path: alias, realPath: realpathSync(target),
      entryPoints: [join(alias, "a.ts"), join(alias, "b.js")], source: "member", issues: [],
    }]);
    expect(discoverMemberExtensionEntries(root)).toEqual([join(alias, "a.ts"), join(alias, "b.js")]);
  });

  it("recognizes scripts and index directories, excludes ordinary and install artifacts", () => {
    file(join(root, "solo.ts"));
    mkdirSync(join(root, "indexed")); file(join(root, "indexed", "index.js"));
    mkdirSync(join(root, "ordinary")); file(join(root, "ordinary", "ignored.ts"));
    mkdirSync(join(root, "node_modules")); file(join(root, "node_modules", "index.js"));
    file(join(root, "package.json"), "{}"); file(join(root, "package-lock.json"), "{}");
    file(join(root, ".hidden.js")); file(join(root, "notes.md"));
    expect(discoverMemberExtensions(root).map((a) => a.name)).toEqual(["indexed", "solo.ts"]);
    expect(discoverMemberExtensionEntries(join(root, "absent"))).toEqual([]);
  });

  it("reports broken links and invalid manifests without falling back to index.ts", () => {
    symlinkSync(join(root, "missing"), join(root, "broken"));
    mkdirSync(join(root, "bad-json")); file(join(root, "bad-json", "package.json"), "{");
    file(join(root, "bad-json", "index.ts"));
    pkg(join(root, "bad-list"), { pi: { extensions: [null] } });
    file(join(root, "bad-list", "index.ts"));
    const assets = discoverMemberExtensions(root);
    expect(assets).toHaveLength(3);
    for (const a of assets) { expect(a.issues.length).toBeGreaterThan(0); expect(a.entryPoints).toEqual([]); }
    expect(assets.find((a) => a.name === "broken")?.realPath).toBeNull();
    expect(discoverMemberExtensionEntries(root)).toEqual([]);
  });

  it("reports invalid entry files while retaining valid declared entries; empty declarations are authoritative", () => {
    const dir = join(root, "partial");
    pkg(dir, { name: "partial-pkg", pi: { extensions: ["ok.js", "absent.js", "directory.js"] } });
    file(join(dir, "ok.js")); mkdirSync(join(dir, "directory.js"));
    pkg(join(root, "empty"), { pi: { extensions: [] } }); file(join(root, "empty", "index.ts"));
    const [asset] = discoverMemberExtensions(root);
    expect(asset.name).toBe("partial-pkg");
    expect(asset.issues).toHaveLength(2);
    expect(asset.entryPoints).toEqual([join(dir, "ok.js")]);
    expect(discoverMemberExtensionEntries(root)).toEqual(asset.entryPoints);
  });

  it("reports dangling index and manifest links instead of hiding extension directories", () => {
    mkdirSync(join(root, "indexed"));
    symlinkSync(join(root, "absent"), join(root, "indexed", "index.ts"));
    mkdirSync(join(root, "manifested"));
    symlinkSync(join(root, "absent"), join(root, "manifested", "package.json"));
    const assets = discoverMemberExtensions(root);
    expect(assets).toHaveLength(2);
    for (const a of assets) { expect(a.entryPoints).toEqual([]); expect(a.issues).toHaveLength(1); }
  });

  it("surfaces an invalid extensions root rather than claiming an empty inventory", () => {
    const path = join(root, "not-a-directory"); file(path);
    expect(() => discoverMemberExtensions(path)).toThrow();
  });

  it("deduplicates repeated declarations and symlink aliases for runtime", () => {
    const dir = join(root, "node_modules", "pkg");
    pkg(dir, { name: "same", pi: { extensions: ["main.ts", "main.ts"] } }); file(join(dir, "main.ts"));
    symlinkSync(dir, join(root, "first")); symlinkSync(dir, join(root, "second"));
    expect(discoverMemberExtensions(root)).toHaveLength(2);
    expect(discoverMemberExtensionEntries(root)).toEqual([join(root, "first", "main.ts")]);
  });

  it("preserves standalone symlink names and uses package name with an index entry", () => {
    file(join(root, "node-source")); symlinkSync(join(root, "node-source"), join(root, "linked.js"));
    pkg(join(root, "folder"), { name: "named" }); file(join(root, "folder", "index.ts"));
    const assets = discoverMemberExtensions(root);
    expect(assets.map((a) => a.name)).toEqual(["named", "linked.js"]);
    expect(assets[1].realPath).toBe(join(root, "node-source"));
  });
});
