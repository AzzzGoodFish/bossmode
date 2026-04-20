// Unit tests for the single-namespace filesystem knowledge store (0.8.0)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Provide a mutable bossmode dir for the store to use each test
let tmpDir: string = "";
vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
  seedTemplates: () => {},
}));

describe("Knowledge single-namespace store (0.8.0)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bossmode-kb-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addEntry writes markdown with frontmatter at chosen path", async () => {
    const { addEntry, getEntry } = await import("../../src/knowledge/store.js");
    const entry = addEntry("Architecture Overview", "# Overview\n\nSome content.", "architect", "bossmode/architecture/overview.md");
    expect(entry.id).toBe("bossmode/architecture/overview.md");
    expect(entry.title).toBe("Architecture Overview");

    const abs = join(tmpDir, "knowledge", "docs", "bossmode", "architecture", "overview.md");
    expect(existsSync(abs)).toBe(true);
    const raw = readFileSync(abs, "utf-8");
    expect(raw).toMatch(/^---\n/);
    expect(raw).toMatch(/title: Architecture Overview/);
    expect(raw).toMatch(/# Overview/);

    const got = getEntry("bossmode/architecture/overview.md");
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Architecture Overview");
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
    expect(updated!.title).toBe("New");
    expect(updated!.content).toBe("new content");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("deleteEntry removes file and cleans empty parent folders", async () => {
    const { addEntry, deleteEntry, getEntry } = await import("../../src/knowledge/store.js");
    addEntry("T", "c", "user", "deep/nested/folder/doc.md");
    const abs = join(tmpDir, "knowledge", "docs", "deep", "nested", "folder", "doc.md");
    expect(existsSync(abs)).toBe(true);

    expect(deleteEntry("deep/nested/folder/doc.md")).toBe(true);
    expect(getEntry("deep/nested/folder/doc.md")).toBeNull();
    expect(existsSync(join(tmpDir, "knowledge", "docs", "deep"))).toBe(false);
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
    expect(searchEntries("guide").length).toBe(2); // finds both across project folders
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

  it("listEntries parses pre-existing markdown files with frontmatter", async () => {
    const { listEntries } = await import("../../src/knowledge/store.js");
    const docsRoot = join(tmpDir, "knowledge", "docs", "manual");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "hand-written.md"),
      "---\ntitle: Hand-Written Doc\nauthor: fish\n---\n\nBody content.\n",
      "utf-8",
    );

    const entries = listEntries();
    const found = entries.find((e) => e.id === "manual/hand-written.md");
    expect(found).toBeDefined();
    expect(found!.title).toBe("Hand-Written Doc");
    expect(found!.source).toBe("fish");
    expect(found!.content.trim()).toBe("Body content.");
  });

  it("listEntries / getDocumentTree handle an empty docs root", async () => {
    const { listEntries, getDocumentTree } = await import("../../src/knowledge/store.js");
    expect(listEntries()).toEqual([]);
    const tree = getDocumentTree();
    expect(tree.kind).toBe("folder");
    expect(tree.children ?? []).toEqual([]);
  });
});
