// Shared YAML frontmatter parser — used by skill and document readers
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

/**
 * Strip markdown code segments (inline `…` and fenced ``` blocks) from message
 * text, replacing them with same-length whitespace so offsets stay stable.
 *
 * Used before mention parsing/rendering: code is literal text, never a command
 * — an `@name` inside backticks must not activate or tint (designer alignment
 * blocker, architect ruling 2026-08-04).
 */
export function stripCodeSegments(text: string): string {
  return text
    // fenced blocks first (they may contain single backticks); unclosed fence runs to end
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => " ".repeat(m.length))
    // inline code (single line)
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}
