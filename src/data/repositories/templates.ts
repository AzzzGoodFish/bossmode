import type { Database } from "../database.js";

export const templateMetadataKeys = ["name", "description", "avatar", "tags", "model", "skills"] as const;

/** Lookup identity is never inferred from the editable display name. No persona bytes in SQL. */
export interface TemplateMetadata {
  slug: string;
  name: string;
  description: string;
  avatar?: string;
  model?: string;
  tags?: string[];
  skills?: string[];
  personaPath: string;
  /** Unrecognized YAML metadata, including source/version, retained for explicit exports. */
  extensions: Record<string, unknown>;
}
interface Row {
  slug: string; display_name: string; description: string; avatar: string | null; model: string | null;
  tags_present: number; skills_present: number; persona_path: string; extensions_json: string;
}

export function validateTemplateSlug(slug: string): void {
  if (!slug || slug === "." || slug === ".." || /[\\/\0]/.test(slug)) throw new Error("Invalid agent template slug");
}

export function validateTemplatePath(slug: string, path: string): void {
  validateTemplateSlug(slug);
  const parts = path.split("/");
  if (parts.length < 3 || parts[0] !== "agents" || parts[1] !== slug || parts.at(-1) !== "persona.md"
    || parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p))) throw new Error("Invalid agent persona path");
}

/** Explicit initialized Database only; never opens, binds, migrates, or reads legacy files. */
export class TemplateRepository {
  constructor(private readonly db: Database) {}

  has(slug: string): boolean {
    validateTemplateSlug(slug);
    return !!this.db.get("SELECT 1 FROM agent_templates WHERE slug=?", slug);
  }

  get(slug: string): TemplateMetadata | null {
    validateTemplateSlug(slug);
    const row = this.db.get<Row>("SELECT * FROM agent_templates WHERE slug=?", slug);
    return row ? this.decode(row) : null;
  }

  list(): TemplateMetadata[] {
    return this.db.all<Row>("SELECT * FROM agent_templates ORDER BY slug").map(row => this.decode(row));
  }

  upsert(template: TemplateMetadata): void {
    validateTemplatePath(template.slug, template.personaPath);
    for (const key of templateMetadataKeys) {
      if (Object.hasOwn(template.extensions, key)) throw new Error(`Known template metadata cannot be duplicated in extensions: ${key}`);
    }
    const extensions = JSON.stringify(template.extensions);
    this.db.transaction(tx => {
      tx.run(`INSERT INTO agent_templates
        (slug,display_name,description,avatar,model,tags_present,skills_present,persona_path,extensions_json)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET
        display_name=excluded.display_name, description=excluded.description, avatar=excluded.avatar,
        model=excluded.model, tags_present=excluded.tags_present, skills_present=excluded.skills_present,
        persona_path=excluded.persona_path, extensions_json=excluded.extensions_json`,
      template.slug, template.name, template.description, template.avatar ?? null, template.model ?? null,
      Number(template.tags !== undefined), Number(template.skills !== undefined), template.personaPath, extensions);
      for (const [table, values] of [["agent_template_tags", template.tags], ["agent_template_skills", template.skills]] as const) {
        tx.run(`DELETE FROM ${table} WHERE slug=?`, template.slug);
        values?.forEach((value, position) => tx.run(`INSERT INTO ${table} (slug,position,value) VALUES (?,?,?)`, template.slug, position, value));
      }
    });
  }

  delete(slug: string): boolean {
    return this.db.transaction(tx => {
      if (!new TemplateRepository(tx).has(slug)) return false;
      tx.run("DELETE FROM agent_templates WHERE slug=?", slug);
      return true;
    });
  }

  private decode(row: Row): TemplateMetadata {
    const values = (table: string) => this.db.all<{value: string}>(`SELECT value FROM ${table} WHERE slug=? ORDER BY position`, row.slug).map(v => v.value);
    return {
      slug: row.slug, name: row.display_name, description: row.description,
      avatar: row.avatar ?? undefined, model: row.model ?? undefined,
      tags: row.tags_present ? values("agent_template_tags") : undefined,
      skills: row.skills_present ? values("agent_template_skills") : undefined,
      personaPath: row.persona_path, extensions: JSON.parse(row.extensions_json),
    };
  }
}
