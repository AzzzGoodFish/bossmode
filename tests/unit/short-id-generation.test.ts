import { afterEach, beforeEach, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { isShortMemberId, isShortRoomId } from "../../src/shared/short-id.js";

let fixture: ReturnType<typeof coreFixture>;
let root: string;
beforeEach(() => { fixture = coreFixture(); root = fixture.root; });
afterEach(() => fixture.close());

it("member birth and room creation mint short ids (mem_/rm_ + nanoid10)", async () => {
  const { createMember } = await import("../../src/workspace/member-registry.js");
  const { createRoom } = await import("../../src/workspace/room-store.js");

  const a = createMember({ name: "Alpha" });
  const b = createMember({ name: "Beta" });
  expect(a.id).toMatch(/^mem_[0-9a-z]{10}$/);
  expect(isShortMemberId(a.id)).toBe(true);
  expect(a.id).not.toMatch(/-/); // nanoid alphabet excludes the separator chars
  expect(a.id.slice(4)).toMatch(/^[0-9a-z]{10}$/); // tail only, no `_`/`-`
  expect(b.id).not.toBe(a.id);

  const room = createRoom("Room A", undefined, [a.id, b.id]);
  expect(room.id).toMatch(/^rm_[0-9a-z]{10}$/);
  expect(isShortRoomId(room.id)).toBe(true);
  expect(room.id).not.toMatch(/-/);
  const second = createRoom("Room B", undefined, [a.id]);
  expect(second.id).not.toBe(room.id);

  // The minted ids are the durable row ids (not display aliases).
  expect(fixture.db.get("SELECT 1 FROM members WHERE id=?", a.id)).toBeDefined();
  expect(fixture.db.get("SELECT 1 FROM rooms WHERE id=?", room.id)).toBeDefined();
  // dm scopes for the fresh members keep the bare-id contract.
  expect(fixture.db.get("SELECT 1 FROM scopes WHERE id=?", `dm:${a.id}`)).toBeDefined();
});

it("keeps minting distinct ids across many births", async () => {
  const { createMember } = await import("../../src/workspace/member-registry.js");
  const ids = new Set<string>();
  for (let index = 0; index < 25; index++) ids.add(createMember({ name: `Member ${index}` }).id);
  expect(ids.size).toBe(25);
  for (const id of ids) expect(isShortMemberId(id)).toBe(true);
});
