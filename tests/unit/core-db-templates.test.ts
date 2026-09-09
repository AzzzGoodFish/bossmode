import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, bindDatabase, openDatabase, type Database } from "../../src/storage/database.js";
import { templatesMigration } from "../../src/storage/schema/templates.js";
import { TemplateRepository } from "../../src/storage/repositories/templates.js";
import { importAgentTemplates, legacyAgentTemplateSources, parseAgentDefinitionMarkdown, readTemplateBody, seedAgentTemplates, type TemplateSource } from "../../src/workforce/template-files.js";
import { deleteAgentDefinition, hasAgentDefinition, listAgentTemplateMetadata, loadAgentDefinition, loadAgentDefinitions, loadAgentDefinitionsStrict, loadAgentTemplates, renderAgentDefinitionMarkdown, saveAgentDefinition } from "../../src/workforce/agent-store.js";
import { seedBuiltinAssets } from "../../src/workforce/team-updates.js";

// The real config intentionally freezes its root at import; this fixture supplies a per-test root.
// npm test has already established BOSSMODE_DIR isolation before any application import.
vi.mock("../../src/shared/config.js", () => ({ getBossmodeDir: () => process.env.BOSSMODE_DIR! }));

const ioFailure = vi.hoisted(() => ({
  partialBody: false,
  syncPath: "",
  synced: [] as string[],
  openPaths: new Map<number, string>(),
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      ioFailure.openPaths.set(fd, String(args[0]));
      return fd;
    }),
    closeSync: (fd: number) => {
      ioFailure.openPaths.delete(fd);
      fs.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      const path = ioFailure.openPaths.get(fd)!;
      if (path === ioFailure.syncPath) throw new Error("injected directory fsync failure");
      fs.fsyncSync(fd);
      ioFailure.synced.push(path);
    },
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (ioFailure.partialBody && typeof args[0] === "number") {
      fs.writeFileSync(args[0], "partial");
      throw new Error("injected partial write");
    }
    return fs.writeFileSync(...args);
  }) };
});

let root: string;
let db: Database;
let repository: TemplateRepository;
const originalDir = process.env.BOSSMODE_DIR;
const originalCwd = process.cwd();
const source = (slug: string, markdown: string): TemplateSource => ({ slug, markdown, path: `agents/${slug}.md` });
const mixed = '---\nname: Display Name\ndescription: Description\navatar: ""\ntags: [a, a, z]\nmodel: provider/model\nskills: []\nsource: custom\nversion: 9\nextra:\n  nested: [true, 2, null]\n---\n\n  Persona preserved.  \n\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bossmode-template-unit-"));
  process.env.BOSSMODE_DIR = root;
  mkdirSync(join(root, "knowledge"));
  db = openDatabase(join(root, "test.sqlite"));
  applyStorageMigrations(db, [templatesMigration]);
  bindDatabase(db);
  repository = new TemplateRepository(db);
});
afterEach(() => {
  ioFailure.partialBody = false;
  ioFailure.syncPath = "";
  ioFailure.synced = [];
  ioFailure.openPaths.clear();
  vi.restoreAllMocks();
  db.close();
  process.chdir(originalCwd);
  process.env.BOSSMODE_DIR = originalDir;
  rmSync(root, { recursive: true, force: true });
});

function stageAsset(path: string, bytes: Uint8Array): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

describe("DB agent-template registry", () => {
  it("normalizes metadata and ordered duplicate arrays, keeps slug separate and body only in files", () => {
    const saved = saveAgentDefinition("lookup", mixed);
    expect(saved.name).toBe("Display Name");
    expect(saved.tags).toEqual(["a", "a", "z"]);
    expect(saved.skills).toEqual([]);
    expect(saved.avatar).toBe("");
    expect(saved.systemPrompt).toBe("\n  Persona preserved.  \n\n");
    expect(loadAgentDefinition("lookup")).toEqual(saved);
    expect(loadAgentDefinition("Display Name")).toBeNull();
    expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
    const metadata = repository.get("lookup")!;
    expect(readFileSync(join(root, metadata.personaPath), "utf8")).toBe(saved.systemPrompt);
    expect(metadata.extensions).toEqual({ source: "custom", version: 9, extra: { nested: [true, 2, null] } });
    const row = db.get<Record<string, unknown>>("SELECT * FROM agent_templates")!;
    expect(JSON.stringify(row)).not.toContain("Persona preserved");
    expect(JSON.parse(row.extensions_json as string)).not.toHaveProperty("name");
    expect(db.all("SELECT value FROM agent_template_tags ORDER BY position")).toEqual([{value: "a"}, {value: "a"}, {value: "z"}]);
    const rendered = renderAgentDefinitionMarkdown("lookup")!;
    expect(parseAgentDefinitionMarkdown("lookup", rendered)).toEqual(parseAgentDefinitionMarkdown("lookup", mixed));
    expect(listAgentTemplateMetadata()[0].slug).toBe("lookup");
  });

  it("preserves absent versus empty arrays and blank/no-frontmatter bodies", () => {
    saveAgentDefinition("absent", "no envelope\n");
    expect(repository.get("absent")!.tags).toBeUndefined();
    expect(repository.get("absent")!.skills).toBeUndefined();
    expect(loadAgentDefinition("absent")!.tags).toEqual([]);
    expect(renderAgentDefinitionMarkdown("absent")).not.toContain("tags:");
    saveAgentDefinition("empty", "---\nname: empty\ntags: []\nskills: []\n---\n");
    expect(repository.get("empty")!.tags).toEqual([]);
    expect(repository.get("empty")!.skills).toEqual([]);
    expect(loadAgentDefinition("empty")!.systemPrompt).toBe("");
    expect(renderAgentDefinitionMarkdown("empty")).toContain("skills: []");
  });

  it.each(["\n", "\r\n"])("preserves empty frontmatter defaults and exact bodies with %j delimiters", newline => {
    for (const body of ["", "body", "\r\n  中文 body.  \n\r\n", "---\nbody delimiter\n---\r\n"]) {
      for (const terminator of body ? [newline] : ["", newline]) {
        const markdown = `---${newline}---${terminator}${body}`;
        const parsed = parseAgentDefinitionMarkdown("empty-envelope", markdown);
        expect(parsed).toEqual({ metadata: {
          slug: "empty-envelope", name: "empty-envelope", description: "",
          avatar: undefined, model: undefined, tags: undefined, skills: undefined, extensions: {},
        }, body });
        const saved = saveAgentDefinition("empty-envelope", markdown);
        expect(saved).toEqual({ name: "empty-envelope", description: "", avatar: undefined,
          model: undefined, tags: [], skills: undefined, systemPrompt: body });
        expect(loadAgentDefinition("empty-envelope")).toEqual(saved);
        expect(readFileSync(join(root, repository.get("empty-envelope")!.personaPath))).toEqual(Buffer.from(body));
        expect(parseAgentDefinitionMarkdown("empty-envelope", renderAgentDefinitionMarkdown("empty-envelope")!)).toEqual(parsed);
      }
    }
  });

  it.each(["\n", "\r\n"])("preserves nonempty frontmatter and exact empty/nonempty bodies with %j delimiters", newline => {
    for (const body of ["", "\r\n  Persona.  \n\r\n"]) {
      const markdown = ["---", "name: Display", "extra: keep", "---", body].join(newline);
      const saved = saveAgentDefinition("envelope", markdown);
      expect(saved.name).toBe("Display");
      expect(saved.systemPrompt).toBe(body);
      expect(repository.get("envelope")!.extensions).toEqual({ extra: "keep" });
      expect(readFileSync(join(root, repository.get("envelope")!.personaPath))).toEqual(Buffer.from(body));
    }
  });

  it("never discovers or falls back to legacy .md, and lists fail if any referenced body is missing", () => {
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents/retired.md"), mixed);
    expect(loadAgentDefinitions()).toEqual([]);
    expect(loadAgentDefinition("retired")).toBeNull();
    saveAgentDefinition("valid", "valid");
    saveAgentDefinition("broken", "broken");
    unlinkSync(join(root, repository.get("broken")!.personaPath));
    writeFileSync(join(root, "agents/broken.md"), "must not rescue missing body");
    expect(() => loadAgentDefinitionsStrict()).toThrow();
    expect(() => loadAgentDefinitions()).toThrow();
    expect(() => loadAgentDefinition("broken")).toThrow();
    expect(hasAgentDefinition("broken")).toBe(true);
  });

  it("prepares a new complete body without damaging the saved body on SQL failure or outer rollback", () => {
    saveAgentDefinition("stable", "old body");
    const previous = repository.get("stable")!;
    db.exec("CREATE TRIGGER reject_template BEFORE UPDATE ON agent_templates BEGIN SELECT RAISE(ABORT,'injected SQL failure'); END");
    expect(() => saveAgentDefinition("stable", "new body")).toThrow("injected SQL failure");
    expect(repository.get("stable")).toEqual(previous);
    expect(readTemplateBody(root, previous)).toBe("old body");
    db.exec("DROP TRIGGER reject_template");
    expect(() => db.transaction(() => {
      saveAgentDefinition("stable", "rolled back body");
      throw new Error("outer failure");
    })).toThrow("outer failure");
    expect(loadAgentDefinition("stable")!.systemPrompt).toBe("old body");
  });

  it("does not publish metadata on a file write failure and rejects unsafe paths", () => {
    writeFileSync(join(root, "agents"), "not a directory");
    expect(() => saveAgentDefinition("new", "body")).toThrow();
    expect(repository.list()).toEqual([]);
    expect(() => saveAgentDefinition("../escape", "body")).toThrow("Invalid agent template slug");
    expect(() => saveAgentDefinition("bad\\slug", "body")).toThrow();
  });

  it("does not reference a partially written replacement body", () => {
    saveAgentDefinition("stable", "complete old body");
    const metadata = repository.get("stable")!;
    ioFailure.partialBody = true;
    expect(() => saveAgentDefinition("stable", "replacement body")).toThrow("injected partial write");
    ioFailure.partialBody = false;
    expect(repository.get("stable")).toEqual(metadata);
    expect(loadAgentDefinition("stable")!.systemPrompt).toBe("complete old body");
  });

  it.each(["agents", "agents/retry"])("re-syncs ancestors after %s mkdir succeeds but its parent fsync fails", created => {
    const parent = join(root, created, "..");
    mkdirSync(parent, { recursive: true });
    ioFailure.syncPath = parent;
    expect(() => saveAgentDefinition("retry", "identical body")).toThrow("injected directory fsync failure");
    expect(existsSync(join(root, created))).toBe(true);
    expect(repository.list()).toEqual([]);

    // Visibility is not durability: a second failure at the existing ancestor must still abort.
    expect(() => saveAgentDefinition("retry", "identical body")).toThrow("injected directory fsync failure");
    expect(repository.list()).toEqual([]);
    ioFailure.syncPath = "";
    ioFailure.synced = [];
    const upsert = TemplateRepository.prototype.upsert;
    vi.spyOn(TemplateRepository.prototype, "upsert").mockImplementation(function (this: TemplateRepository, metadata) {
      const directory = join(root, metadata.personaPath, "..");
      expect(ioFailure.synced).toEqual(expect.arrayContaining([
        join(directory, ".persona.tmp"), directory, join(root, "agents/retry"), join(root, "agents"), root,
      ]));
      expect(ioFailure.synced.every(path => path === root || path.startsWith(`${root}/`))).toBe(true);
      return upsert.call(this, metadata);
    });
    saveAgentDefinition("retry", "identical body");
    expect(loadAgentDefinition("retry")!.systemPrompt).toBe("identical body");
  });

  it.each(["", "agents", "agents/stable"])("blocks publication on renewed %j fsync failure even with an existing matching body", ancestor => {
    saveAgentDefinition("stable", "identical body");
    const previous = repository.get("stable")!;
    ioFailure.syncPath = join(root, ancestor);
    const publication = vi.spyOn(TemplateRepository.prototype, "upsert");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => saveAgentDefinition("stable", "identical body")).toThrow("injected directory fsync failure");
      expect(publication).not.toHaveBeenCalled();
      expect(repository.get("stable")).toEqual(previous);
      expect(readTemplateBody(root, previous)).toBe("identical body");
    }
    ioFailure.syncPath = "";
    saveAgentDefinition("stable", "identical body");
    expect(publication).toHaveBeenCalledOnce();
    expect(loadAgentDefinition("stable")!.systemPrompt).toBe("identical body");
  });

  it("rejects symlinked persona reads/writes", () => {
    saveAgentDefinition("safe", "body");
    const metadata = repository.get("safe")!;
    unlinkSync(join(root, metadata.personaPath));
    writeFileSync(join(root, "other"), "outside");
    symlinkSync(join(root, "other"), join(root, metadata.personaPath));
    expect(() => loadAgentDefinition("safe")).toThrow("symlink");
    symlinkSync(root, join(root, "agents/linked"));
    expect(() => saveAgentDefinition("linked", "body")).toThrow("symlink");
  });

  it("removes SQL metadata and relations without deleting content needed by an outer rollback", () => {
    saveAgentDefinition("lookup", mixed);
    const path = repository.get("lookup")!.personaPath;
    expect(() => db.transaction(() => {
      expect(deleteAgentDefinition("lookup")).toBe(true);
      throw new Error("rollback delete");
    })).toThrow("rollback delete");
    expect(loadAgentDefinition("lookup")!.name).toBe("Display Name");
    expect(deleteAgentDefinition("lookup")).toBe(true);
    expect(deleteAgentDefinition("lookup")).toBe(false);
    expect(loadAgentDefinition("lookup")).toBeNull();
    expect(db.all("SELECT * FROM agent_template_tags")).toEqual([]);
    expect(existsSync(join(root, path))).toBe(true);
  });

  it("does not initialize schema or database from a repository or public getter", () => {
    const empty = openDatabase(join(root, "empty.sqlite"));
    try {
      expect(() => new TemplateRepository(empty).list()).toThrow("no such table");
      expect(empty.all("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
    } finally { empty.close(); }
    db.close();
    expect(() => loadAgentDefinitions()).toThrow("not initialized");
    expect(loadAgentTemplates().length).toBeGreaterThan(0);
  });

  it("rejects malformed frontmatter before file publication and duplicate known extension metadata", () => {
    expect(() => saveAgentDefinition("invalid", "---\n[a, b]\n---\nbody")).toThrow("mapping");
    expect(() => saveAgentDefinition("invalid", "---\nname: [\n---\nbody")).toThrow();
    expect(() => saveAgentDefinition("invalid", "---\nname: x")).toThrow("Unterminated");
    expect(existsSync(join(root, "agents"))).toBe(false);
    saveAgentDefinition("valid", "body");
    expect(() => repository.upsert({ ...repository.get("valid")!, extensions: { tags: ["bad"] } })).toThrow("duplicated");
  });
});

describe("pure legacy import and package seeding", () => {
  it("uses only supplied inventory and stages exact bodies before metadata, and can repeat deterministically", () => {
    expect(legacyAgentTemplateSources(["agents/a.md", "agents/a/persona.md", "skills/a/SKILL.md", "backup/agents/b.md"])).toEqual([{path: "agents/a.md", retire: true}]);
    const staged = new Map<string, Uint8Array>();
    const context = { db, stageAsset: (path: string, bytes: Uint8Array) => {
      expect(repository.has("lookup")).toBe(false);
      staged.set(path, bytes);
    } };
    importAgentTemplates(context, [source("lookup", mixed)]);
    const metadata = repository.get("lookup")!;
    expect(Buffer.from(staged.get(metadata.personaPath)!).toString()).toBe("\n  Persona preserved.  \n\n");
    expect(existsSync(join(root, "agents"))).toBe(false);
    importAgentTemplates({ db, stageAsset }, [source("lookup", mixed)]);
    expect(repository.list()).toHaveLength(1);
    expect(repository.get("lookup")).toEqual(metadata);
    expect(loadAgentDefinition("lookup")!.name).toBe("Display Name");
  });

  it("publishes no metadata on stage failure, validates all sources first, and rolls back a bad SQL batch", () => {
    let calls = 0;
    expect(() => importAgentTemplates({db, stageAsset: () => { if (++calls === 2) throw new Error("stage failed"); }}, [source("a", "a"), source("b", "b")])).toThrow("stage failed");
    expect(repository.list()).toEqual([]);
    calls = 0;
    expect(() => importAgentTemplates({db, stageAsset: () => { calls++; }}, [source("a", "a"), source("a", "b")])).toThrow("Duplicate");
    expect(calls).toBe(0);
    db.exec("CREATE TRIGGER reject_b BEFORE INSERT ON agent_templates WHEN NEW.slug='b' BEGIN SELECT RAISE(ABORT,'batch failure'); END");
    expect(() => importAgentTemplates({db, stageAsset}, [source("a", "a"), source("b", "b")])).toThrow("batch failure");
    expect(repository.list()).toEqual([]);
  });

  it("seeds only missing SQL slugs, preserves package extensions and imported edits without reseeding missing bodies", () => {
    const inventory = [source("lookup", mixed), source("factory", "---\nname: Factory\next: keep\n---\nfactory body")];
    importAgentTemplates({db, stageAsset}, [source("lookup", "edited")]);
    expect(seedAgentTemplates({db, stageAsset}, inventory, "1.2.3")).toBe(1);
    expect(repository.get("factory")!.extensions).toEqual({ ext: "keep", source: "builtin", version: "1.2.3" });
    expect(loadAgentDefinition("lookup")!.systemPrompt).toBe("edited");
    unlinkSync(join(root, repository.get("factory")!.personaPath));
    expect(seedAgentTemplates({db, stageAsset: () => { throw new Error("must not stage"); }}, inventory, "1.2.4")).toBe(0);
    expect(() => loadAgentDefinition("factory")).toThrow();
  });

  it("team-updates agent branch uses DB presence; permitted skill and rule assets remain files", () => {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "templates/agents"), { recursive: true });
    mkdirSync(join(packageRoot, "templates/skills/demo"), { recursive: true });
    mkdirSync(join(packageRoot, "templates/teams/dev-team"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"version":"test-version"}');
    writeFileSync(join(packageRoot, "templates/agents/factory.md"), mixed);
    writeFileSync(join(packageRoot, "templates/skills/demo/SKILL.md"), "---\nname: demo\n---\nallowed skill");
    writeFileSync(join(packageRoot, "templates/teams/dev-team/team-prompt.md"), "# Protocol\nallowed rule");
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents/factory.md"), "retired, not authority");
    process.chdir(packageRoot);
    seedBuiltinAssets();
    expect(repository.get("factory")!.name).toBe("Display Name");
    expect(repository.get("factory")!.extensions.version).toBe("test-version");
    expect(readFileSync(join(root, "agents/factory.md"), "utf8")).toBe("retired, not authority");
    expect(readFileSync(join(root, "skills/demo/SKILL.md"), "utf8")).toContain("allowed skill");
    expect(readFileSync(join(root, "memory/projects/rules/team-dev-protocol.md"), "utf8")).toContain("allowed rule");
    saveAgentDefinition("factory", "local edit");
    const path = repository.get("factory")!.personaPath;
    unlinkSync(join(root, "agents/factory.md"));
    seedBuiltinAssets();
    expect(repository.get("factory")!.personaPath).toBe(path);
    expect(loadAgentDefinition("factory")!.systemPrompt).toBe("local edit");
    expect(existsSync(join(root, "agents/factory.md"))).toBe(false);
    expect(readFileSync(join(packageRoot, "templates/agents/factory.md"), "utf8")).toBe(mixed);
  });
});
