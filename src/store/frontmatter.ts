// Shared YAML frontmatter parser — used by agent-defs, skill-store, team-store
import { parse as parseYaml } from "yaml";

export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  return { meta: parseYaml(match[1]) ?? {}, body: match[2].trim() };
}

// Helper: safely extract string array from frontmatter value
export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

// Helper: safely extract string
export function asString(value: unknown, fallback: string = ""): string {
  if (typeof value === "string") return value;
  if (value != null) return String(value);
  return fallback;
}
