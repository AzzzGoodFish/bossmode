import {
  getMemberTokenUsage,
  getRoomMembers,
  getRooms,
  type MemberInfo,
  type Room,
} from "../api/client";

export interface RoomMemberFact {
  roomId: string;
  roomName: string;
  memberId: string;
  memberName: string;
  agent: string;
  sourceAgent?: string;
  model: string | null;
  thinkingLevel: string | null;
  mcpServers: string[];
  status: string;
  totalTokens: number;
}

function factKey(roomId: string, memberId: string): string {
  return `${roomId}:${memberId}`;
}

export function matchesAgentFact(fact: RoomMemberFact, agentName: string): boolean {
  return fact.agent === agentName || fact.sourceAgent === agentName;
}

export function projectRoomMemberFacts(
  rooms: Room[],
  membersByRoom: Map<string, MemberInfo[]>,
  tokenUsageByMember: Map<string, number> = new Map(),
): RoomMemberFact[] {
  return rooms.flatMap((room) => (membersByRoom.get(room.id) || []).map((member) => ({
    roomId: room.id,
    roomName: room.name,
    memberId: member.id,
    memberName: member.name,
    agent: member.agent,
    sourceAgent: member.sourceAgent,
    model: member.model ?? null,
    thinkingLevel: member.thinkingLevel ?? null,
    mcpServers: member.mcpServers ?? [],
    status: room.agentStatuses?.[member.name] || "inactive",
    totalTokens: tokenUsageByMember.get(factKey(room.id, member.id)) ?? 0,
  })));
}

/** Load the real room-local member projection used by Team pages. */
export async function loadRoomMemberFacts(): Promise<RoomMemberFact[]> {
  const rooms = await getRooms();
  const membersByRoom = new Map(await Promise.all(rooms.map(async (room) => [room.id, await getRoomMembers(room.id)] as const)));
  const initialFacts = projectRoomMemberFacts(rooms, membersByRoom);
  const tokenUsage = await Promise.all(initialFacts.map(async (fact) => [
    factKey(fact.roomId, fact.memberId),
    (await getMemberTokenUsage(fact.memberId, fact.roomId)).totalTokens,
  ] as const));
  return projectRoomMemberFacts(rooms, membersByRoom, new Map(tokenUsage));
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
