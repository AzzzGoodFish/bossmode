#!/usr/bin/env node
/**
 * Thin CLI for the batch-6 member-assets migration.
 * Logic lives in dist/member/migrations/member-assets-migration.js (daemon uses the same module).
 *
 * Usage:
 *   node scripts/migrate-member-assets-v6.mjs              # dry-run (report only)
 *   node scripts/migrate-member-assets-v6.mjs --apply      # write member mcp.json + archive platform config
 *   BOSSMODE_DIR=/path node scripts/migrate-member-assets-v6.mjs --apply
 *
 * Prefer: after `npm run build`, or run from an installed package that ships dist/.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distMod = join(root, "dist", "member", "migrations", "member-assets-migration.js");

async function loadModule() {
  if (existsSync(distMod)) {
    return import(pathToFileURL(distMod).href);
  }
  console.error(
    "member-assets-migration module not found. Run `npm run build` first, or use an installed bossmode package.",
  );
  process.exit(1);
}

const mod = await loadModule();
const dryRun = !process.argv.includes("--apply");
const report = mod.runMemberAssetsMigration({ dryRun });

for (const entry of report.members) {
  const suffix = entry.serverCount > 0 ? ` (${entry.serverCount} servers)` : "";
  console.log(`${dryRun ? "[dry-run] " : ""}${entry.action.padEnd(16)} ${entry.name}${suffix}`);
}
console.log(
  `${dryRun ? "[dry-run] " : ""}platform config archived: ${report.platformArchived}`,
);
if (process.env.MIGRATE_JSON_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.MIGRATE_JSON_OUT, JSON.stringify(report, null, 2));
}
process.exit(0);
