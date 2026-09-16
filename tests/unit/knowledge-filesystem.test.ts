
// Unit tests for the single-namespace filesystem knowledge store (0.8.0)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Use the isolated root established before application imports.
let tmpDir: string = "";
vi.mock("../../src/config/settings.js", () => ({
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
  seedTemplates: () => {}
}));

describe("Knowledge single-namespace store (0.8.0)", () => {
  beforeEach(() => {
    tmpDir = process.env.BOSSMODE_DIR!;
    mkdirSync(tmpDir, {recursive:true});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addEntry writes plain markdown without injecting frontmatter", async () => {
    const { addEntry, getEntry } = await import("../../src/knowledge/store.js");
    const entry = addEntry("Architecture Overview", "# Overview\n\nSome content.", "architect", "bossmode/architecture/overview.md");
    expect(entry.id).toBe("bossmode/architecture/overview.md");
    expect(entry.title).toBe("Overview");

    const abs = join(tmpDir, "memory", "projects", "bossmode", "architecture", "overview.md");
    expect(existsSync(abs)).toBe(true);
    const raw = readFileSync(abs, "utf-8");
    expect(raw).toBe("# Overview\n\nSome content.");
    expect(raw).not.toMatch(/^---\n/);

    const got = getEntry("bossmode/architecture/overview.md");
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Overview");
    expect(got!.content).toContain("# Overview");
  });

  it("rejects path traversal and absolute paths", async () => {
    const { addEntry } = await import("../../src/knowledge/store.js");
    expect(() => addEntry("bad", "content", "x", "../escape.md")).toThrow();
    expect(() => addEntry("bad", "content", "x", "/etc/passwd")).toThrow();
  });

  it("appends .md extension if missing", async () => {
    const { addEntry } = await import("../../src/knowledge/store.js");
    const e = addEntry("T", "c", "user", "notes/quick");
    expect(e.id).toBe("notes/quick.md");
  });

  it("updateEntry overwrites content and refreshes updatedAt", async () => {
    const { addEntry, updateEntry, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("Old", "old content", "user", "notes/doc.md");
    const before = getEntry("notes/doc.md")!;
    const updated = updateEntry("notes/doc.md", "New", "new content");
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("doc");
    expect(updated!.content).toBe("new content");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("deleteEntry removes file and cleans empty parent folders", async () => {
    const { addEntry, deleteEntry, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("T", "c", "user", "deep/nested/folder/doc.md");
    const abs = join(tmpDir, "memory", "projects", "deep", "nested", "folder", "doc.md");
    expect(existsSync(abs)).toBe(true);

    expect(deleteEntry("deep/nested/folder/doc.md")).toBe(true);
    expect(getEntry("deep/nested/folder/doc.md")).toBeNull();
    expect(existsSync(join(tmpDir, "memory", "projects", "deep"))).toBe(false);
  });

  it("getDocumentTree returns hierarchical structure", async () => {
    const { addEntry, getDocumentTree } = await import("../../src/knowledge/store.js");
    addEntry("Overview", "c", "user", "bossmode/architecture/overview.md");
    addEntry("TechDebt", "c", "user", "bossmode/architecture/tech-debt.md");
    addEntry("PRD", "c", "user", "bossmode/prds/feature-x.md");
    addEntry("FreeU arch", "c", "user", "freeu/architecture/map.md");
    addEntry("Root doc", "c", "user", "top-level.md");

    const tree = getDocumentTree();
    expect(tree.kind).toBe("folder");
    expect(tree.children).toBeDefined();
    const topLevel = tree.children!.map((c) => c.path);
    expect(topLevel).toContain("bossmode");
    expect(topLevel).toContain("freeu");
    expect(topLevel).toContain("top-level.md");

    const bossmode = tree.children!.find((c) => c.path === "bossmode")!;
    expect(bossmode.kind).toBe("folder");
    const bmSubPaths = bossmode.children!.map((c) => c.path);
    expect(bmSubPaths).toContain("bossmode/architecture");
    expect(bmSubPaths).toContain("bossmode/prds");
  });

  it("searchEntries performs case-insensitive substring search across whole tree", async () => {
    const { addEntry, searchEntries } = await import("../../src/knowledge/store.js");
    addEntry("React Guide", "Use React hooks for state", "user", "bossmode/guides/react.md");
    addEntry("Vue Guide", "Use Vue composition API", "user", "freeu/guides/vue.md");

    expect(searchEntries("react").length).toBe(1);
    expect(searchEntries("HOOKS").length).toBe(1);
    expect(searchEntries("guide").length).toBe(0); // no frontmatter title; heading/filename/content only
    expect(searchEntries("nothing").length).toBe(0);
  });

  it("moveEntry renames without overwriting existing", async () => {
    const { addEntry, moveEntry, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("A", "a", "user", "x.md");
    addEntry("B", "b", "user", "y.md");

    expect(moveEntry("x.md", "y.md")).toBeNull(); // would overwrite
    expect(getEntry("x.md")).not.toBeNull();

    expect(moveEntry("x.md", "archive/z.md")).not.toBeNull();
    expect(getEntry("x.md")).toBeNull();
    expect(getEntry("archive/z.md")).not.toBeNull();
  });

  it("moveFolder renames directory and returns moved file mappings", async () => {
    const { addEntry, moveFolder, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("A", "a", "user", "bossmode/rules/a.md");
    addEntry("B", "b", "user", "bossmode/rules/sub/b.md");

    const moved = moveFolder("bossmode/rules", "bossmode/protocols");
    expect(moved.ok).toBe(true);
    expect(moved.movedFiles).toContainEqual(["bossmode/rules/a.md", "bossmode/protocols/a.md"]);
    expect(moved.movedFiles).toContainEqual(["bossmode/rules/sub/b.md", "bossmode/protocols/sub/b.md"]);

    expect(getEntry("bossmode/rules/a.md")).toBeNull();
    expect(getEntry("bossmode/protocols/a.md")).not.toBeNull();
  });

  it("deleteFolder removes recursively and returns deleted paths", async () => {
    const { addEntry, deleteFolder, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("A", "a", "user", "bossmode/rules/a.md");
    addEntry("B", "b", "user", "bossmode/rules/sub/b.md");

    const deleted = deleteFolder("bossmode/rules");
    expect(deleted.ok).toBe(true);
    expect(deleted.deletedCount).toBe(2);
    expect(deleted.deletedPaths).toContain("bossmode/rules/a.md");
    expect(deleted.deletedPaths).toContain("bossmode/rules/sub/b.md");

    expect(getEntry("bossmode/rules/a.md")).toBeNull();
    expect(getEntry("bossmode/rules/sub/b.md")).toBeNull();
  });

  it("listEntries treats pre-existing frontmatter as plain markdown content", async () => {
    const { listEntries } = await import("../../src/knowledge/store.js");
    const docsRoot = join(tmpDir, "memory", "projects", "manual");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "hand-written.md"),
      "---\ntitle: Hand-Written Doc\nauthor: fish\n---\n\nBody content.\n",
      "utf-8",
    );

    const entries = listEntries();
    const found = entries.find((e) => e.id === "manual/hand-written.md");
    expect(found).toBeDefined();
    expect(found!.title).toBe("hand written");
    expect(found!.source).toBe("user");
    expect(found!.content.trim()).toContain("title: Hand-Written Doc");
    expect(found!.content.trim()).toContain("Body content.");
  });

  it("rejects traversal, unsupported, invalid, and oversize png uploads", async () => {
    const { writePngEntry, _internal } = await import("../../src/knowledge/store.js");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    expect(() => writePngEntry("../swatch.png", png)).toThrow();
    expect(() => writePngEntry("swatch.jpg", png)).toThrow(/Only \.png/);
    expect(() => writePngEntry("swatch.png", Buffer.from("not png"))).toThrow(/Invalid PNG/);
    expect(() => writePngEntry("huge.png", Buffer.concat([png, Buffer.alloc(_internal.MAX_PNG_BYTES)]))).toThrow(/too large/);
  });

  it("shows html and png allowlisted files and reads png through raw endpoint helper", async () => {
    const { addEntry, getDocumentTree, getEntry, getRawEntry, writePngEntry } = await import("../../src/knowledge/store.js");
    addEntry("Hero", "<!doctype html><h1>Hero</h1>", "user", "site/hero.html");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    writePngEntry("site/swatch.png", png);

    const tree = getDocumentTree();
    const site = tree.children!.find((node) => node.path === "site")!;
    expect(site.children!.map((node) => node.path)).toEqual(["site/hero.html", "site/swatch.png"]);
    expect(getEntry("site/hero.html")!.content).toContain("<h1>Hero</h1>");
    expect(getEntry("site/swatch.png")).toBeNull();
    expect(getRawEntry("site/swatch.png")!.contentType).toBe("image/png");
    expect(getRawEntry("site/swatch.png")!.data.equals(png)).toBe(true);
  });

  it("listEntries / getDocumentTree handle an empty docs root", async () => {
    const { listEntries, getDocumentTree } = await import("../../src/knowledge/store.js");
    expect(listEntries()).toEqual([]);
    const tree = getDocumentTree();
    expect(tree.kind).toBe("folder");
    expect(tree.children ?? []).toEqual([]);
  });
});
