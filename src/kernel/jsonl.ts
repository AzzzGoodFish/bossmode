/**
 * Resilient JSONL line parsing.
 *
 * A single corrupt/truncated line (disk full, crash mid-write) must never take
 * down an entire room or event stream. Callers get good lines only; bad lines
 * are skipped with a warn log. Read paths never write/repair the file.
 */
import { logger } from "./logger.js";

export interface ParseJsonlOptions {
  /** Log category, e.g. "message-store". */
  category: string;
  /** Extra context for the warn log (roomId, path, …). */
  context?: Record<string, unknown>;
  /** Optional map applied to each successfully parsed value. */
  map?: (value: unknown, lineNo: number) => unknown;
}

/**
 * Parse newline-delimited JSON content. Empty / whitespace-only lines are
 * ignored. Bad lines are skipped (not thrown).
 */
export function parseJsonlLines<T = unknown>(
  content: string,
  options: ParseJsonlOptions,
): T[] {
  if (!content) return [];
  const out: T[] = [];
  // Do not trim the whole content first — that would hide a trailing partial
  // line's position. Split and skip empties per line.
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      out.push((options.map ? options.map(value, i + 1) : value) as T);
    } catch (err) {
      logger.warn(options.category, "skipped corrupt jsonl line", {
        ...(options.context || {}),
        lineNo: i + 1,
        error: err instanceof Error ? err.message : String(err),
        preview: line.length > 120 ? `${line.slice(0, 120)}…` : line,
      });
    }
  }
  return out;
}

/**
 * Parse a file's JSONL content from a string that may already be trimmed.
 * Convenience wrapper used by message/event readers.
 */
export function parseJsonlContent<T = unknown>(
  content: string,
  options: ParseJsonlOptions,
): T[] {
  return parseJsonlLines<T>(content, options);
}
