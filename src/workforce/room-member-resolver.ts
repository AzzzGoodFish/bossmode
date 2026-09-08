import { loadAgentDefinition } from "./agent-store.js";
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
      avatar: roomMember.avatar || loadAgentDefinition(member.agentTemplate)?.avatar,
      model: config.model ?? undefined,
      credentialId: config.credentialId ?? undefined,
      thinkingLevel: config.thinkingLevel || "off",
      skills: config.skills,
      mcpServers: config.mcpServers,
      createdAt: roomMember.createdAt,
      ...(member.title ? { title: member.title } : {}),
    };
  }

  // Explicit migrations materialize legacy member configuration in the room.
  const agent = roomMember.sourceAgent || roomMember.name;
  const agentDef = loadAgentDefinition(agent);
  if (!agentDef && !roomMember.migratedFrom) return null;
  const config = roomMember.config || {};
  return {
    id: roomMember.id,
    name: roomMember.name,
    type: "agent",
    agent,
    runtime: "pi-cli",
    avatar: roomMember.avatar || agentDef?.avatar,
    model: config.model,
    credentialId: config.credentialId,
    thinkingLevel: config.thinkingLevel || "off",
    contextLimit: config.contextLimit,
    skills: config.skills,
    mcpServers: config.mcpServers ?? [],
    createdAt: roomMember.createdAt,
  };
}

function resolveDirectAgent(roomId: string, memberName: string): AgentMemberConfig | null {
  if (memberName.startsWith("mem_")) return null;
  const room = roomStore.getRoom(roomId);
  // A missing current member must not be revived as a same-named direct agent.
  if (Array.isArray(room?.globalMemberIds)) return null;
  const agentDef = loadAgentDefinition(memberName);
  if (!agentDef) return null;
  const override = room?.memberOverrides?.[memberName] || {};
  return {
    id: memberName,
    name: memberName,
    type: "agent",
    agent: memberName,
    runtime: "pi-cli",
    avatar: agentDef.avatar,
    model: override.model,
    credentialId: override.credentialId,
    thinkingLevel: override.thinkingLevel || "off",
    mcpServers: override.mcpServers ?? [],
  };
}

export function resolveRoomMember(roomId: string, memberRef: string): AgentMemberConfig | null {
  const roomMember = roomStore.resolveRoomMemberRef(roomId, memberRef);
  if (roomMember) return toAgentMemberConfig(roomMember);
  return resolveDirectAgent(roomId, memberRef);
}

export function resolveRoomMembers(roomId: string, memberRefs?: string[]): AgentMemberConfig[] {
  const roomMembers = roomStore.getRoomMembers(roomId);
  if (roomMembers.length > 0) return roomMembers.map(toAgentMemberConfig).filter((m): m is AgentMemberConfig => Boolean(m));
  return (memberRefs || []).map((name) => resolveRoomMember(roomId, name)).filter((m): m is AgentMemberConfig => Boolean(m));
}
