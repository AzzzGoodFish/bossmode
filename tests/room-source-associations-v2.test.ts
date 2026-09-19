import { afterEach, expect, it } from "vitest";
import { listRoomSourceAssociations, storeRoom } from "../src/chat/conversations.js";
import { readRoomIdMigrations } from "../src/data/id-migrations.js";
import { coreFixture } from "./helpers/core-fixture.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function setup() {
  const fixture = coreFixture();
  fixtures.push(fixture);
  return fixture;
}

it("reads only exact persisted room ID mappings from data", () => {
  const { db } = setup();
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES(?,?,?,?)", "room", "legacy-z", "rm_z", 1);
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES(?,?,?,?)", "member", "legacy-member", "mem_new", 2);
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES(?,?,?,?)", "room", "legacy-a", "rm_a", 3);

  expect(readRoomIdMigrations(db)).toEqual([
    { oldId: "legacy-a", newId: "rm_a" },
    { oldId: "legacy-z", newId: "rm_z" },
  ]);
});

it("bounds room source aliases to current rooms and removes globally ambiguous aliases", () => {
  const { db } = setup();
  storeRoom({ id: "rm_alpha", name: "Alpha", memberIds: [], createdAt: 3 }, db);
  storeRoom({ id: "rm_beta", name: "Beta", memberIds: [], createdAt: 2 }, db);
  storeRoom({ id: "rm_gamma", name: "Gamma", memberIds: [], createdAt: 1 }, db);

  // One clean migration, one old ID colliding with another current room, and one orphan target.
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)", "legacy-alpha", "rm_alpha", 1);
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)", "rm_beta", "rm_gamma", 2);
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)", "rm_alpha", "rm_deleted", 3);
  // No transitive inference: only rows whose new ID is a current room are candidates.
  db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)", "legacy-grandparent", "legacy-alpha", 4);

  expect(listRoomSourceAssociations(db)).toEqual([
    {
      roomId: "rm_alpha",
      roomName: "Alpha",
      sourceRefs: ["room:legacy-alpha", "room:rm_alpha"],
      historicalSourceKeys: ["legacy-alpha", "rm_alpha"],
    },
    {
      roomId: "rm_beta",
      roomName: "Beta",
      sourceRefs: [],
      historicalSourceKeys: [],
    },
    {
      roomId: "rm_gamma",
      roomName: "Gamma",
      sourceRefs: ["room:rm_gamma"],
      historicalSourceKeys: ["rm_gamma"],
    },
  ]);
});
