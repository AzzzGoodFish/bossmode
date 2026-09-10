import * as roomStore from "../workspace/room-store.js";
import { getEffectiveConfig, getMember, MemberNotFoundError } from "../workspace/member-registry.js";
import type { AgentMemberConfig, RoomMemberRecord } from "../shared/types.js";

function toAgentMemberConfig(roomMember: RoomMemberRecord): AgentMemberConfig | null {
  const globalId = roomMember.id.startsWith("mem_") ? roomMember.id
    : roomMember.sourceMemberId?.startsWith("mem_") ? roomMember.sourceMemberId : undefined;
  if (globalId) {
    // Current identity and configuration come exclusively from the database.
    // Cleared values must never revive config from a historical room shadow.
    const member = getMember(globalId);
    if (!member) throw new MemberNotFoundError(globalId);
    const config = getEffectiveConfig(globalId, `room:${roomMember.roomId}`);
    return {
      id: globalId,
      name: member.name,
      type: "agent",
      agent: member.agentTemplate,
      runtime: "pi-cli",
      model: config.model ?? undefined,
      credentialId: config.credentialId ?? undefined,
      thinkingLevel: config.thinkingLevel || "off",
      skills: config.skills,
      mcpServers: config.mcpServers,
      createdAt: roomMember.createdAt,
      ...(member.title ? { title: member.title } : {}),
    };
  }

  // Legacy snapshots are display/import data, not executable members.
  return null;
}

export function resolveRoomMember(roomId: string, memberRef: string): AgentMemberConfig | null {
  const roomMember = roomStore.resolveRoomMemberRef(roomId, memberRef);
  if (roomMember) return toAgentMemberConfig(roomMember);
  return null;
}

export function resolveRoomMembers(roomId: string, memberRefs?: string[]): AgentMemberConfig[] {
  const roomMembers = roomStore.getRoomMembers(roomId);
  if (roomMembers.length > 0) return roomMembers.map(toAgentMemberConfig).filter((m): m is AgentMemberConfig => Boolean(m));
  return (memberRefs || []).map((name) => resolveRoomMember(roomId, name)).filter((m): m is AgentMemberConfig => Boolean(m));
}
