import type { StorageMigration } from "../database.js";

export const templatesMigration: StorageMigration = {
  id: "core-templates-v1",
  sql: `
    CREATE TABLE agent_templates (
      slug TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar TEXT,
      model TEXT,
      tags_present INTEGER NOT NULL CHECK (tags_present IN (0,1)),
      skills_present INTEGER NOT NULL CHECK (skills_present IN (0,1)),
      persona_path TEXT NOT NULL UNIQUE,
      extensions_json TEXT NOT NULL CHECK (json_valid(extensions_json) AND json_type(extensions_json) = 'object')
    );
    CREATE TABLE agent_template_tags (
      slug TEXT NOT NULL REFERENCES agent_templates(slug) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (slug, position)
    );
    CREATE TABLE agent_template_skills (
      slug TEXT NOT NULL REFERENCES agent_templates(slug) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (slug, position)
    );
    CREATE INDEX agent_template_skill_value ON agent_template_skills(value, slug);
  `,
};
