import { describe, expect, it } from "vitest";
import {
  MEMBER_ID_PREFIX,
  ROOM_ID_PREFIX,
  SHORT_ID_LENGTH,
  generateShortId,
  newMemberId,
  newRoomId,
} from "../../src/kernel/ids.js";

const OLD_MEMBER_ID = /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OLD_ROOM_MEMBER_RECORD = /^rm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("short member/room ids (batch 5 shapes)", () => {
  it("generates prefixed ids with the nanoid(10) shape", () => {
    const memberId = newMemberId();
    expect(memberId.startsWith(MEMBER_ID_PREFIX)).toBe(true);
    expect(memberId.slice(MEMBER_ID_PREFIX.length)).toMatch(/^[0-9a-z]{10}$/);
    expect(memberId.length).toBe(MEMBER_ID_PREFIX.length + SHORT_ID_LENGTH);

    const roomId = newRoomId();
    expect(roomId.startsWith(ROOM_ID_PREFIX)).toBe(true);
    expect(roomId.slice(ROOM_ID_PREFIX.length)).toMatch(/^[0-9a-z]{10}$/);
    expect(roomId.length).toBe(ROOM_ID_PREFIX.length + SHORT_ID_LENGTH);
  });

  it("old and new shapes cannot collide (no dashes in the alphabet, different lengths)", () => {
    // 言实's review requirement (batch 5): nanoid has no `-`; lengths differ.
    for (let i = 0; i < 500; i++) {
      const memberId = newMemberId();
      const roomId = newRoomId();
      expect(memberId).not.toMatch(OLD_MEMBER_ID);
      expect(roomId).not.toMatch(OLD_ROOM_MEMBER_RECORD);
      expect(memberId.includes("-")).toBe(false);
      expect(roomId.includes("-")).toBe(false);
      // Old member id: `mem_` + uuid = 40 chars; new: 14. Legacy `rm_<uuid>` records stay 39.
      expect(memberId.length).toBe(14);
      expect(roomId.length).toBe(13);
      // mm: scope split stays unambiguous: a nanoid segment can never contain `mem_`.
      expect(memberId.slice(MEMBER_ID_PREFIX.length).includes("mem_")).toBe(false);
    }
  });

  it("generates distinct ids in a sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(newMemberId());
    expect(seen.size).toBe(2000);
  });


  it("supports a custom short-id length for future uses", () => {
    expect(generateShortId(4)).toMatch(/^[0-9a-z]{4}$/);
  });
});
