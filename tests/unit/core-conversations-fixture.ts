import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";

/** Domain seed helpers over the shared complete current schema, never an old projection. */
export function conversationsFixture() {
  const storage = coreFixture();
  const repository = () => new ConversationsRepository();
  return {
    ...storage,
    get db() { return storage.db; },
    repository,
    member(id: string, name: string, createdAt = 1) {
      storage.db.run(`INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at)
        VALUES (?,?,?,'general','{}',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,updated_at=excluded.updated_at`,
        id, name, name.toLowerCase(), createdAt, createdAt);
    },
    room(id = "room-uuid") {
      const room = { id, name: "工作 👋", members: [], globalMemberIds: [], createdAt: 0 };
      repository().upsertRoom(room);
      return room;
    },
  };
}
