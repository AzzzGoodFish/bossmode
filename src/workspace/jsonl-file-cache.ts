/**
 * Process-local cache for fully-parsed JSONL files.
 * Keyed by absolute path + (mtimeMs, size). Unchanged files skip re-read/parse.
 * Writers should call invalidateJsonlCache after mutating a file so same-ms
 * appends never serve a stale parse (mtime resolution can be coarse).
 */
import { existsSync, readFileSync, statSync } from "node:fs";

type CacheEntry = {
  mtimeMs: number;
  size: number;
  value: unknown;
};

const cache = new Map<string, CacheEntry>();

/** Read + parse with mtime/size validation. Missing file → emptyResult (not cached). */
export function readJsonlCached<T>(
  path: string,
  parse: (content: string) => T,
  emptyResult: T,
): T {
  if (!existsSync(path)) {
    cache.delete(path);
    return emptyResult;
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return emptyResult;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.value as T;
  }
  // Full read+parse before publish — concurrent readers never see a half-built value.
  const content = readFileSync(path, "utf-8");
  const value = parse(content);
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

export function invalidateJsonlCache(path: string): void {
  cache.delete(path);
}

/** Test helper. */
export function clearJsonlCaches(): void {
  cache.clear();
}

/** Test helper — current entry count. */
export function jsonlCacheSize(): number {
  return cache.size;
}
