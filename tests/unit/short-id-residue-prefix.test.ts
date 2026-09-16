import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Force a generated id that *contains* the legacy id as a substring: `mem_a` is a
// prefix of `mem_agx4g1idiv`. The residue self-check must not mistake the product
// of the rewrite for a leftover.
vi.mock("../../src/kernel/ids.js", async (original) => {
  const actual = await original<typeof import("../../src/kernel/ids.js")>();
  return { ...actual, newMemberId: () => "mem_agx4g1idiv", newRoomId: () => "rm_zzzzzzzzzz" };
});

import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { migrateShortIds } from "../../src/app/upgrade/ids.js";

let root: string;
let db: Database | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "short-id-residue-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

it("does not treat a new id that contains the legacy id as a substring as residue", () => {
  db = openDatabase(join(root, "bossmode.db"));
  applyStorageMigrations(db, coreStorageMigrations);
  db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    "mem_a", "Old", "old", "general", "{}", 1, 1,
  );
  db.run(
    "INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES (?,?,?,?,?,?,?)",
    "members/mem_a/persona.md", "mainline", "mem_a", null, 1, "h", 1,
  );
  db.run(
    "INSERT INTO memory_document_history(document_path,ordinal,revision,scope_id,ts,actor_type,actor_member_id,actor_name,operation,reason,content_hash,content_length,snapshot_path,snapshot_hash,snapshot_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "members/mem_a/persona.md", 1, 1, null, 1, "member", "mem_a", "Old", "update", "test", "h", 1,
    "members/mem_a/history/persona/s1.md", "h", 1,
  );
  mkdirSync(join(root, "members", "mem_a"), { recursive: true });
  writeFileSync(join(root, "members", "mem_a", "persona.md"), "body");

  // Before the fix this threw: the rewritten path still contained `mem_a` as the
  // prefix of `mem_agx4g1idiv` and the residue self-check aborted the migration.
  const report = migrateShortIds(root, db);
  expect(report.status).toBe("migrated");
  expect(db.get<{ new_id: string }>("SELECT new_id FROM id_migration_map WHERE kind='member' AND old_id='mem_a'")!.new_id).toBe("mem_agx4g1idiv");
  expect(db.get<{ path: string }>("SELECT path FROM memory_documents")!.path).toBe("members/mem_agx4g1idiv/persona.md");
  const history = db.get<{ document_path: string; snapshot_path: string }>("SELECT document_path,snapshot_path FROM memory_document_history")!;
  expect(history.document_path).toBe("members/mem_agx4g1idiv/persona.md");
  expect(history.snapshot_path).toBe("members/mem_agx4g1idiv/history/persona/s1.md");
});
