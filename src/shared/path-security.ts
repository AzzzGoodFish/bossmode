// Path validation with whitelist + symlink defense
import { resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

export interface PathPolicy {
  allowedPrefixes: string[];
  maxSizeBytes?: number;
}

export type PathCheckResult =
  | { ok: true; absolutePath: string; size: number }
  | { ok: false; error: string };

/**
 * Validate a path against a whitelist policy.
 * - Resolves to absolute path
 * - Resolves symlinks via realpathSync (critical: prevents symlink escape)
 * - Checks resolved path is under an allowed prefix
 * - Verifies file exists and is a regular file
 * - Optionally enforces max size
 */
export function checkPath(input: string, policy: PathPolicy): PathCheckResult {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "Invalid path" };
  }
  let abs: string;
  try {
    abs = resolve(input);
    abs = realpathSync(abs); // resolves symlinks; throws ENOENT if missing
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, error: `File not found: ${input}` };
    return { ok: false, error: `Cannot resolve path: ${err.message}` };
  }
  const allowed = policy.allowedPrefixes.some(
    (prefix) => abs === prefix || abs.startsWith(prefix + sep),
  );
  if (!allowed) {
    return { ok: false, error: `Path outside allowed locations: ${input}` };
  }
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ok: false, error: `Not a regular file: ${input}` };
    size = st.size;
  } catch (err: any) {
    return { ok: false, error: `Stat failed: ${err.message}` };
  }
  if (policy.maxSizeBytes !== undefined && size > policy.maxSizeBytes) {
    const maxMB = Math.round(policy.maxSizeBytes / 1024 / 1024);
    return { ok: false, error: `File too large (max ${maxMB}MB): ${input}` };
  }
  return { ok: true, absolutePath: abs, size };
}
