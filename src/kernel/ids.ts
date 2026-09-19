/**
 * Short member/room ids (batch 5; design: architecture/short-id-migration-detail-20260915.md).
 *
 * Format: `<prefix><id>` where the id is 10 chars over [0-9a-z] — the nanoid(10) shape.
 * The alphabet deliberately excludes `-` and `_`:
 *  - old member ids (`mem_<uuid>`) and legacy room-member records (`rm_<uuid>`) contain
 *    dashes, so the old and new shapes can never collide;
 *  - the `mm:` scope pair split (second `mem_` occurrence) and every `startsWith("mem_")`
 *    check keep working for both generations.
 *
 * Generator: node:crypto `randomInt` over the alphabet (no new dependency). If the team
 * wants the literal `nanoid` package later, only the draw implementation swaps — the
 * shapes and invariants above stay frozen.
 */
import { randomInt } from "node:crypto";

export const MEMBER_ID_PREFIX = "mem_";
export const ROOM_ID_PREFIX = "rm_";
export const SHORT_ID_LENGTH = 10;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Draw `length` unbiased characters over [0-9a-z]. */
export function generateShortId(length: number = SHORT_ID_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function newMemberId(): string {
  return `${MEMBER_ID_PREFIX}${generateShortId()}`;
}

export function newRoomId(): string {
  return `${ROOM_ID_PREFIX}${generateShortId()}`;
}

const reShortMemberId = /^mem_[0-9a-z]{10}$/;
const reShortRoomId = /^rm_[0-9a-z]{10}$/;
export function isShortMemberId(value: string): boolean { return reShortMemberId.test(value); }
export function isShortRoomId(value: string): boolean { return reShortRoomId.test(value); }

