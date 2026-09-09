import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, applyStorageMigrations, bindDatabase, type Database } from "../../src/storage/database.js";
import { coreStorageMigrations } from "../../src/storage/migrations.js";

/** Explicit current-schema SQL fixture. Migration/bootstrap tests deliberately do not use it.
 * No application import hook initializes storage and no legacy projection opener is involved.
 * File-asset tests must point their config seam at the returned root, not at production HOME.
 */
export function coreFixture() {
  const sandbox = process.env.BOSSMODE_TEST_ROOT;
  if (!sandbox || readFileSync(join(sandbox, ".bossmode-test-sandbox"), "utf8") !== "bossmode-test-run-v1\n") {
    throw new Error("Core fixtures require the isolated npm test launcher");
  }
  const root = mkdtempSync(join(sandbox, "core-"));
  const path = join(root, "bossmode.db");
  mkdirSync(join(root, "knowledge"));
  let db: Database;
  function open() {
    const next = openDatabase(path);
    try { applyStorageMigrations(next, coreStorageMigrations); bindDatabase(next); return next; }
    catch (error) { next.close(); throw error; }
  }
  try { db = open(); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  return {
    root, path,
    get db() { return db; },
    reopen() { db.close(); db = open(); return db; },
    close() { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
