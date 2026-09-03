#!/usr/bin/env node
/**
 * Thin CLI for member-assets-v6 migration.
 * Logic lives in dist/workspace/member-assets-migration.js (daemon uses the same module).
 *
 * Usage:
 *   node scripts/migrate-member-assets-v6.mjs              # dry-run
 *   node scripts/migrate-member-assets-v6.mjs --apply      # write
 *   BOSSMODE_DIR=/path node scripts/migrate-member-assets-v6.mjs --apply
 *
 * Prefer: after `npm run build`, or run from an installed package that ships dist/.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const root = join(__dirname, "..");
const distMod = join(root, "dist", "workspace", "member-assets-migration.js");

async function loadRunner() {
  if (existsSync(distMod)) {
    return import(pathToFileURL(distMod).href);
  }
  // Dev fallback: tsx/ts-node not assumed — require built package next to script.
  const require = createRequire(import.meta.url);
  try {
    return require("../dist/workspace/member-assets-migration.js");
  } catch {
    console.error(
      "member-assets-migration module not found. Run `npm run build` first, or use an installed bossmode package.",
    );
    process.exit(1);
  }
}

const mod = await loadRunner();
const run = mod.runIdentityMigration;
if (typeof run !== "function") {
  console.error("runIdentityMigration export missing");
  process.exit(1);
}

const result = run({ apply });
if (process.env.MIGRATE_JSON_OUT) {
  writeFileSync(process.env.MIGRATE_JSON_OUT, JSON.stringify(result, null, 2));
}
if (result.error) {
  console.error("migration error:", result.error);
  process.exit(2);
}
process.exit(0);
