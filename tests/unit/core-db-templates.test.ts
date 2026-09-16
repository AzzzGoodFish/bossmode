import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
const templatesMigration = getMigration("core-templates-v1");
import { TemplateRepository } from "../../src/data/repositories/templates.js";
import { importAgentTemplates, legacyAgentTemplateSources, parseAgentDefinitionMarkdown, readTemplateBody, type TemplateSource } from "../../src/app/upgrade/records.js";

let root: string;
let db: Database;
let repository: TemplateRepository;
const source = (slug: string, markdown: string): TemplateSource => ({ slug, markdown, path: `agents/${slug}.md` });
const mixed = '---\nname: Display Name\ndescription: Description\navatar: ""\ntags: [a, a, z]\nmodel: provider/model\nskills: []\nsource: custom\nversion: 9\nextra:\n  nested: [true, 2, null]\n---\n\n  Persona preserved.  \n\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bossmode-template-unit-"));
  db = openDatabase(join(root, "test.sqlite"));
  applyStorageMigrations(db, [templatesMigration]);
  repository = new TemplateRepository(db);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

// Import adapter unit boundary only. Real durable staging is covered by the upgrade suite.
function stageAsset(path: string, bytes: Uint8Array): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function importSource(slug: string, markdown: string): void {
  importAgentTemplates({ db, stageAsset }, [source(slug, markdown)]);
}
function body(slug: string): string { return readTemplateBody(root, repository.get(slug)!); }

describe("historical agent-template catalog", () => {
  it("normalizes metadata and ordered duplicate arrays, keeps slug separate and body only in files", () => {
    importSource("lookup", mixed);
    const metadata = repository.get("lookup")!;
    expect(metadata).toMatchObject({ name: "Display Name", description: "Description", tags: ["a", "a", "z"], skills: [], avatar: "", model: "provider/model" });
    expect(repository.get("Display Name")).toBeNull();
    expect(body("lookup")).toBe("\n  Persona preserved.  \n\n");
    expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
    expect(metadata.extensions).toEqual({ source: "custom", version: 9, extra: { nested: [true, 2, null] } });
    const row = db.get<Record<string, unknown>>("SELECT * FROM agent_templates")!;
    expect(JSON.stringify(row)).not.toContain("Persona preserved");
    expect(JSON.parse(row.extensions_json as string)).not.toHaveProperty("name");
    expect(db.all("SELECT value FROM agent_template_tags ORDER BY position")).toEqual([{value: "a"}, {value: "a"}, {value: "z"}]);
    expect(repository.list()[0].slug).toBe("lookup");
    importSource("skills", "---\nskills: [z, a, z]\n---\nbody");
    expect(repository.get("skills")!.skills).toEqual(["z", "a", "z"]);
    expect(db.all("SELECT value FROM agent_template_skills ORDER BY position")).toEqual([{value: "z"}, {value: "a"}, {value: "z"}]);
  });

  it("preserves absent versus empty arrays and blank/no-frontmatter bodies", () => {
    importSource("absent", "no envelope\n");
    expect(repository.get("absent")!.tags).toBeUndefined();
    expect(repository.get("absent")!.skills).toBeUndefined();
    expect(body("absent")).toBe("no envelope\n");
    importSource("empty", "---\nname: empty\ntags: []\nskills: []\n---\n");
    expect(repository.get("empty")!.tags).toEqual([]);
    expect(repository.get("empty")!.skills).toEqual([]);
    expect(body("empty")).toBe("");
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
        importSource("empty-envelope", markdown);
        const { personaPath, ...metadata } = repository.get("empty-envelope")!;
        expect(metadata).toEqual(parsed.metadata);
        expect(readFileSync(join(root, personaPath))).toEqual(Buffer.from(body));
      }
    }
  });

  it.each(["\n", "\r\n"])("preserves nonempty frontmatter and exact empty/nonempty bodies with %j delimiters", newline => {
    for (const body of ["", "\r\n  Persona.  \n\r\n"]) {
      importSource("envelope", ["---", "name: Display", "extra: keep", "---", body].join(newline));
      expect(repository.get("envelope")!.name).toBe("Display");
      expect(repository.get("envelope")!.extensions).toEqual({ extra: "keep" });
      expect(readFileSync(join(root, repository.get("envelope")!.personaPath))).toEqual(Buffer.from(body));
    }
  });

  it("never discovers legacy .md or uses it to rescue a missing historical body", () => {
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents/retired.md"), mixed);
    expect(repository.list()).toEqual([]);
    importAgentTemplates({ db, stageAsset }, []);
    expect(repository.get("retired")).toBeNull();
    importSource("broken", "broken");
    unlinkSync(join(root, repository.get("broken")!.personaPath));
    writeFileSync(join(root, "agents/broken.md"), "must not rescue missing body");
    expect(() => body("broken")).toThrow();
    expect(repository.has("broken")).toBe(true);
  });

  it("keeps the previously imported body and catalog on SQL failure or outer rollback", () => {
    importSource("stable", "old body");
    const previous = repository.get("stable")!;
    db.exec("CREATE TRIGGER reject_template BEFORE UPDATE ON agent_templates BEGIN SELECT RAISE(ABORT,'injected SQL failure'); END");
    expect(() => importSource("stable", "new body")).toThrow("injected SQL failure");
    expect(repository.get("stable")).toEqual(previous);
    expect(readTemplateBody(root, previous)).toBe("old body");
    db.exec("DROP TRIGGER reject_template");
    // Stage outside SQL, then exercise rollback of the unchanged historical repository.
    const prepared = new Map<string, Uint8Array>();
    const candidate = openDatabase(join(root, "candidate.sqlite"));
    try {
      applyStorageMigrations(candidate, [templatesMigration]);
      importAgentTemplates({ db: candidate, stageAsset: (path, bytes) => { prepared.set(path, bytes); } }, [source("stable", "rolled back body")]);
      for (const [path, bytes] of prepared) stageAsset(path, bytes);
      expect(() => db.transaction(() => {
        repository.upsert(new TemplateRepository(candidate).get("stable")!);
        throw new Error("outer failure");
      })).toThrow("outer failure");
    } finally { candidate.close(); }
    expect(repository.get("stable")).toEqual(previous);
    expect(body("stable")).toBe("old body");
  });

  it("does not publish metadata on a file write failure and rejects unsafe slugs before staging", () => {
    writeFileSync(join(root, "agents"), "not a directory");
    expect(() => importSource("new", "body")).toThrow();
    expect(repository.list()).toEqual([]);
    const stage = vi.fn();
    for (const slug of ["../escape", "bad\\slug", "", ".", "..", "bad\0slug"]) {
      expect(() => importAgentTemplates({ db, stageAsset: stage }, [source(slug, "body")])).toThrow("Invalid agent template slug");
    }
    expect(stage).not.toHaveBeenCalled();
  });

  it.each(["", "agents", "agents/safe", "body"])("rejects symlinks at historical read boundary %j", target => {
    importSource("safe", "body");
    const metadata = repository.get("safe")!;
    const linked = target === "body" ? metadata.personaPath : target;
    const outside = mkdtempSync(join(tmpdir(), "bossmode-template-link-"));
    try {
      if (linked) rmSync(join(root, linked), { recursive: true, force: true });
      else rmSync(join(root, "agents"), { recursive: true, force: true });
      if (!linked) {
        const alias = join(outside, "root");
        symlinkSync(root, alias);
        expect(() => readTemplateBody(alias, metadata)).toThrow("symlink");
      } else {
        symlinkSync(outside, join(root, linked));
        expect(() => readTemplateBody(root, metadata)).toThrow("symlink");
      }
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("rejects nonregular bodies, relative roots, traversal and cross-slug references", () => {
    importSource("safe", "body");
    const metadata = repository.get("safe")!;
    for (const personaPath of ["agents/other/persona.md", "agents/safe/../persona.md", "/agents/safe/persona.md", "agents/safe//persona.md", "agents/safe/bad\\dir/persona.md"]) {
      expect(() => readTemplateBody(root, { ...metadata, personaPath })).toThrow("Invalid agent persona path");
      expect(() => repository.upsert({ ...metadata, personaPath })).toThrow("Invalid agent persona path");
    }
    expect(() => readTemplateBody("relative", metadata)).toThrow("absolute");
    unlinkSync(join(root, metadata.personaPath));
    mkdirSync(join(root, metadata.personaPath));
    expect(() => body("safe")).toThrow("regular file");
  });

  it("preserves historical repository delete rollback, relation cleanup and unreferenced bodies", () => {
    importSource("lookup", mixed);
    const metadata = repository.get("lookup")!;
    expect(() => db.transaction(() => {
      expect(repository.delete("lookup")).toBe(true);
      throw new Error("rollback delete");
    })).toThrow("rollback delete");
    expect(repository.get("lookup")).toEqual(metadata);
    expect(repository.delete("lookup")).toBe(true);
    expect(repository.delete("lookup")).toBe(false);
    expect(repository.get("lookup")).toBeNull();
    expect(db.all("SELECT * FROM agent_template_tags")).toEqual([]);
    expect(readTemplateBody(root, metadata)).toBe("\n  Persona preserved.  \n\n");
  });

  it("does not initialize schema or database from the historical repository", () => {
    const empty = openDatabase(join(root, "empty.sqlite"));
    try {
      expect(() => new TemplateRepository(empty).list()).toThrow("no such table");
      expect(empty.all("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
    } finally { empty.close(); }
  });

  it("rejects malformed frontmatter before file publication and duplicate known extension metadata", () => {
    expect(() => importSource("invalid", "---\n[a, b]\n---\nbody")).toThrow("mapping");
    expect(() => importSource("invalid", "---\nname: [\n---\nbody")).toThrow();
    expect(() => importSource("invalid", "---\nname: x")).toThrow("Unterminated");
    expect(existsSync(join(root, "agents"))).toBe(false);
    importSource("valid", "body");
    expect(() => repository.upsert({ ...repository.get("valid")!, extensions: { tags: ["bad"] } })).toThrow("duplicated");
  });
});

describe("explicit historical import", () => {
  it("uses only supplied inventory and stages exact bodies before metadata, and can repeat deterministically", () => {
    expect(legacyAgentTemplateSources(["agents/a.md", "agents/a/persona.md", "skills/a/SKILL.md", "backup/agents/b.md", "agents/a\\b.md"])).toEqual([{path: "agents/a.md", retire: true}]);
    const staged = new Map<string, Uint8Array>();
    importAgentTemplates({ db, stageAsset: (path, bytes) => {
      expect(repository.has("lookup")).toBe(false);
      staged.set(path, bytes);
    } }, [source("lookup", mixed)]);
    const metadata = repository.get("lookup")!;
    expect(Buffer.from(staged.get(metadata.personaPath)!)).toEqual(Buffer.from("\n  Persona preserved.  \n\n"));
    expect(existsSync(join(root, "agents"))).toBe(false);
    importSource("lookup", mixed);
    expect(repository.list()).toHaveLength(1);
    expect(repository.get("lookup")).toEqual(metadata);
    expect(body("lookup")).toBe("\n  Persona preserved.  \n\n");
  });

  it("publishes no metadata on stage failure, validates all sources first, and rolls back a bad SQL batch", () => {
    let calls = 0;
    expect(() => importAgentTemplates({db, stageAsset: () => { if (++calls === 2) throw new Error("stage failed"); }}, [source("a", "a"), source("b", "b")])).toThrow("stage failed");
    expect(repository.list()).toEqual([]);
    calls = 0;
    expect(() => importAgentTemplates({db, stageAsset: () => { calls++; }}, [source("a", "a"), source("a", "b")])).toThrow("Duplicate");
    expect(calls).toBe(0);
    expect(() => importAgentTemplates({db, stageAsset: () => { calls++; }}, [source("a", "a"), source("bad", "---\nname: x")])).toThrow("Unterminated");
    expect(calls).toBe(0);
    db.exec("CREATE TRIGGER reject_b BEFORE INSERT ON agent_templates WHEN NEW.slug='b' BEGIN SELECT RAISE(ABORT,'batch failure'); END");
    expect(() => importAgentTemplates({db, stageAsset}, [source("a", "a"), source("b", "b")])).toThrow("batch failure");
    expect(repository.list()).toEqual([]);
  });
});
