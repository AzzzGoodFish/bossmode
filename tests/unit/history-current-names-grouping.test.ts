import { it, expect } from "vitest";
import { isGroupedWithPrev } from "../../web/src/utils/message-grouping.js";
import type { RoomMessage } from "../../web/src/api/client.js";
const message = (sender: string, senderMemberId?: string, offset=0): RoomMessage => ({id:`id-${offset}`,sender,senderMemberId,content:"body",mentions:[],ts:Date.UTC(2026,8,11,12)+offset});
it("groups renamed known authors by ID without merging a reused name or unknown actor",()=>{
  const before=message("old","mem_a"), renamed=message("new","mem_a",1000), reused=message("old","mem_b",1000), unknown=message("old",undefined,1000);
  expect(isGroupedWithPrev(before,renamed)).toBe(true);
  expect(isGroupedWithPrev(before,reused)).toBe(false);
  expect(isGroupedWithPrev(before,unknown)).toBe(false);
  expect(isGroupedWithPrev(unknown,before)).toBe(false);
  expect(isGroupedWithPrev(before,{...renamed,type:"task_event"})).toBe(false);
  expect(isGroupedWithPrev(before,message("new","mem_a",6*60_000))).toBe(false);
  expect(isGroupedWithPrev(message("user"),message("user",undefined,1000))).toBe(true);
});
