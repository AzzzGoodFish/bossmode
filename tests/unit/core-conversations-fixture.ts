import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { messagesMigration, eventSourceMigration } from "../../src/storage/schema/messages.js";
import { conversationsMigration } from "../../src/storage/schema/conversations.js";
import { openDb } from "../../src/workspace/db/sqlite.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { TasksRepository } from "../../src/storage/repositories/tasks.js";

export function conversationsFixture() {
  const root = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!, "conversations-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  const path = join(root, "fixture.db");
  // The old registry schema is initialized only against this explicit fixture.
  // Close its singleton BEFORE the new context owns the connection.
  const legacy = openDb(path);
  legacy.run("INSERT INTO tasks(room_id,task_id,title,status,payload_json) VALUES (?,?,?,?,?)", "obsolete", "projection", "Do not import me", "todo", "{}");
  legacy.close();
  let db: Database = openDatabase(path);
  applyStorageMigrations(db, [baseStorageMigration, conversationsMigration, messagesMigration, eventSourceMigration]);
  bindDatabase(db);
  const repository = () => new ConversationsRepository();
  const tasks = () => new TasksRepository();
  return {
    root, path, repository, tasks,
    get db() { return db; },
    member(id: string, name: string, createdAt = 1) {
      getDatabase().run(`INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at)
        VALUES (?,?,?,'general','{}',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,updated_at=excluded.updated_at`,
        id, name, name.toLowerCase(), createdAt, createdAt);
    },
    room(id = "room-uuid") {
      const room = { id, name: "工作 👋", members: [], globalMemberIds: [], createdAt: 0 };
      repository().upsertRoom(room);
      return room;
    },
    reopen() {
      db.close();
      db = openDatabase(path);
      applyStorageMigrations(db, [baseStorageMigration, conversationsMigration, messagesMigration, eventSourceMigration]);
      bindDatabase(db);
    },
    close() { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
