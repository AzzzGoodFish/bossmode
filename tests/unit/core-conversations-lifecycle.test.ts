import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import { ConversationsRepository, ensureDmScope } from "../../src/storage/repositories/conversations.js";
import { TasksRepository } from "../../src/storage/repositories/tasks.js";
import { getRoom, listRooms, roomDir } from "../../src/workspace/room-store.js";
import { getTopicById } from "../../src/workspace/topic-store.js";
import { listTasks } from "../../src/workspace/task-store.js";
import { queryRoomTasks } from "../../src/workspace/db/tasks-index.js";

let f: ReturnType<typeof conversationsFixture> | undefined;
afterEach(() => { f?.close(); f = undefined; });

it("does not open, bind, migrate or fall back from any domain getter before explicit bootstrap", () => {
  mkdirSync(roomDir("legacy-only"), { recursive: true });
  writeFileSync(join(roomDir("legacy-only"), "room.json"), '{"id":"legacy-only"}');
  const calls = [() => new ConversationsRepository(), () => new TasksRepository(), () => ensureDmScope("mem_a"),
    () => getRoom("legacy-only"), () => listRooms(), () => getTopicById("topic_a"), () => listTasks("legacy-only"), () => queryRoomTasks("legacy-only", {})];
  for (const call of calls) expect(call).toThrow("bootstrap must initialize storage");
  expect(existsSync(join(process.env.BOSSMODE_DIR!, "bossmode.db"))).toBe(false);
});

it("never caches topic ownership across database contexts and surfaces a closed context", () => {
  f = conversationsFixture();
  f.room();
  f.repository().upsertTopic({ id: "stable-topic", roomId: "room-uuid", title: "x", anchorMessageId: "a", createdBy: "user", status: "active", createdAt: 0, seedMode: "fresh", participants: [] });
  expect(getTopicById("stable-topic")!.roomId).toBe("room-uuid");
  const held = f.repository();
  f.close();
  expect(() => held.listRooms()).toThrow("closed");
  expect(() => getRoom("room-uuid")).toThrow("bootstrap must initialize storage");
  f = conversationsFixture();
  expect(getTopicById("stable-topic")).toBeNull();
});
