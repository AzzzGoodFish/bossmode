import { mkdirSync } from "node:fs";

/** Ensure a directory exists without consulting application configuration or SQL. */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}
