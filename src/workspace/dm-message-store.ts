import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import { getDatabase } from "../storage/database.js";
import type { RoomMessage } from "../shared/types.js";
import { appendMessage, readMessages, latestMessage, readDmMemberCursor, writeDmMemberCursor } from "../storage/message-repository.js";

export function readAllDmMessages(memberId: string): RoomMessage[] { return readMessages(`dm:${memberId}`).map(limitRuntimeFailureRoomMessage); }
export function addDmMessage(memberId: string,msg: Omit<RoomMessage,"id" | "ts" | "seq">): RoomMessage { return appendMessage(`dm:${memberId}`,msg); }
export function getDmMessagesSince(memberId: string,afterSeq: number | null): RoomMessage[] {
  return readAllDmMessages(memberId).filter(m => afterSeq === null || (m.seq !== undefined && m.seq > afterSeq));
}
export function getLatestDmMessageId(memberId: string): string | null { return latestMessage(`dm:${memberId}`)?.id ?? null; }
export function getLatestDmSeq(memberId: string): number | null { return latestMessage(`dm:${memberId}`)?.seq ?? null; }
export const getDmCursor = readDmMemberCursor;
export function setDmCursor(memberId: string,cursor: {messageId: string | null; seq: number | null}): void {
  writeDmMemberCursor(getDatabase(),memberId,cursor);
}
