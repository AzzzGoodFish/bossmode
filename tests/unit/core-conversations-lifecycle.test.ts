import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import { getDatabase } from "../../src/data/database.js";
import { ensureDmScope, listStoredRooms } from "../../src/chat/conversations.js";
import {getRoom, listRooms} from "../../src/chat/conversations.js";
import {roomDir} from "../../src/files/layout.js";

let f: ReturnType<typeof conversationsFixture> | undefined;
afterEach(() => { f?.close(); f = undefined; });

it("does not open, bind, migrate or fall back from any domain getter before explicit bootstrap", () => {
  mkdirSync(roomDir("legacy-only"), { recursive: true });
  writeFileSync(join(roomDir("legacy-only"), "room.json"), '{"id":"legacy-only"}');
  const calls = [() => getDatabase(), () => ensureDmScope("mem_a"),
    () => getRoom("legacy-only"), () => listRooms()];
  for (const call of calls) expect(call).toThrow("bootstrap must initialize storage");
  expect(existsSync(join(process.env.BOSSMODE_DIR!, "bossmode.db"))).toBe(false);
});

it("never caches room ownership across database contexts and surfaces a closed context", () => {
  f = conversationsFixture();
  f.room();
  expect(getRoom("room-uuid")!.id).toBe("room-uuid");
  const held = f.db;
  f.close();
  expect(() => listStoredRooms(held)).toThrow("closed");
  expect(() => getRoom("room-uuid")).toThrow("bootstrap must initialize storage");
  f = conversationsFixture();
  expect(getRoom("room-uuid")).toBeNull();
});
