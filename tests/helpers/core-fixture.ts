import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabase, applyStorageMigrations, bindDatabase, type Database } from "../../src/storage/database.js";
import { coreStorageMigrations } from "../../src/storage/migrations.js";

/** Explicit current-schema SQL fixture. Migration/bootstrap tests deliberately do not use it.
 * No application import hook initializes storage and no legacy projection opener is involved.
 * File-asset tests must point their config seam at the returned root, not at production HOME.
 */
export function coreFixture(existingRoot?: string) {
  const sandbox = process.env.BOSSMODE_TEST_ROOT;
  if (!sandbox || readFileSync(join(sandbox, ".bossmode-test-sandbox"), "utf8") !== "bossmode-test-run-v1\n") {
    throw new Error("Core fixtures require the isolated npm test launcher");
  }
  const root = existingRoot ?? mkdtempSync(join(realpathSync(sandbox), "core-"));
  if (root !== resolve(root) || dirname(root) !== realpathSync(sandbox)
    || (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()))) {
    throw new Error("Core fixture root must be a direct, nonsymlink child of the test sandbox");
  }
  const path = join(root, "bossmode.db");
  mkdirSync(join(root, "knowledge"), { recursive: true });
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
