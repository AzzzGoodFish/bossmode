import { resolveRoomMemberRef } from "../../chat/conversations.js";
import { memberTokenTotal } from "../../data/repositories/event-repository.js";
export interface MemberTokenUsageSummary { totalTokens: number }
export function getRoomMemberTokenUsage(roomId: string,memberRef: string): MemberTokenUsageSummary {
  const member = resolveRoomMemberRef(roomId,memberRef);
  return {totalTokens:member ? memberTokenTotal(member.id,roomId) : 0};
}
export function getMemberTokenUsage(memberId: string): MemberTokenUsageSummary { return {totalTokens:memberTokenTotal(memberId)}; }
