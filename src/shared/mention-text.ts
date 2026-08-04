/**
 * Strip markdown code segments (inline `…` and fenced ``` blocks) from message
 * text, replacing them with same-length whitespace so offsets stay stable.
 *
 * Used before mention parsing/rendering: code is literal text, never a command
 * — a `!name` or `@name` inside backticks must not activate, interrupt, or
 * tint (designer alignment blocker, architect ruling 2026-08-04).
 */
export function stripCodeSegments(text: string): string {
  return text
    // fenced blocks first (they may contain single backticks); unclosed fence runs to end
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => " ".repeat(m.length))
    // inline code (single line)
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}
