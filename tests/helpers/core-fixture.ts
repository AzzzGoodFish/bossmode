import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabase, applyStorageMigrations, bindDatabase, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";

/** Explicit current-schema SQL fixture. Migration/bootstrap tests deliberately do not use it.
 * No application import hook initializes storage and no legacy projection opener is involved.
 * Defaults to the test-file asset root installed before application imports.
 */
export function coreFixture(existingRoot?: string) {
  const sandbox = process.env.BOSSMODE_TEST_ROOT;
  if (!sandbox || readFileSync(join(sandbox, ".bossmode-test-sandbox"), "utf8") !== "bossmode-test-run-v1\n") {
    throw new Error("Core fixtures require the isolated npm test launcher");
  }
  const root = existingRoot ?? process.env.BOSSMODE_DIR;
  if (!root) throw new Error("Core fixtures require a test-file asset root");
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
