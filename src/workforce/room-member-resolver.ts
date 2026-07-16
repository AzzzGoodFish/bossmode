import { loadAgentDefinition } from "./agent-store.js";
import * as memberStore from "./member-store.js";
import * as roomStore from "../workspace/room-store.js";
import type { AgentMemberConfig, RoomMemberRecord } from "../shared/types.js";

function toAgentMemberConfig(roomMember: RoomMemberRecord): AgentMemberConfig | null {
  const sourceAgent = roomMember.sourceAgent;
  const getMember = "getMember" in memberStore ? (memberStore as any).getMember as (id: string) => AgentMemberConfig | undefined : undefined;
  const getMemberByName = "getMemberByName" in memberStore ? (memberStore as any).getMemberByName as (name: string) => AgentMemberConfig | undefined : undefined;
  const sourceMember = roomMember.sourceMemberId && getMember
    ? getMember(roomMember.sourceMemberId)
    : roomMember.migratedFrom
      ? getMemberByName?.(roomMember.migratedFrom.memberName || roomMember.name)
      : undefined;
  const agentDef = loadAgentDefinition(sourceAgent || sourceMember?.agent || roomMember.name);
  if (!sourceMember && !agentDef) return null;

  const config = roomMember.config || {};
  return {
    id: roomMember.id,
    name: roomMember.name,
    type: "agent",
    agent: sourceAgent || sourceMember?.agent || roomMember.name,
    runtime: sourceMember?.runtime || "pi-cli",
    avatar: roomMember.avatar || sourceMember?.avatar || agentDef?.avatar,
    model: config.model || sourceMember?.model,
    credentialId: config.credentialId ?? sourceMember?.credentialId,
    thinkingLevel: config.thinkingLevel || sourceMember?.thinkingLevel || "off",
    contextLimit: config.contextLimit ?? sourceMember?.contextLimit,
    skills: config.skills ?? sourceMember?.skills,
    mcpServers: Array.isArray(config.mcpServers) ? config.mcpServers : [],
  };
}

function legacyResolve(roomId: string, memberName: string): AgentMemberConfig | null {
  const getMemberByName = "getMemberByName" in memberStore ? (memberStore as any).getMemberByName as (name: string) => AgentMemberConfig | undefined : undefined;
  const base = getMemberByName?.(memberName);
  const agentDef = loadAgentDefinition(base?.agent || memberName);
  if (!base && !agentDef) return null;

  const override = (roomStore as any).getRoom?.(roomId)?.memberOverrides?.[memberName] || {};
  const member: AgentMemberConfig = base
    ? { ...base }
    : {
        id: memberName,
        name: memberName,
        type: "agent",
        agent: memberName,
        runtime: "pi-cli",
        thinkingLevel: "off",
        avatar: agentDef?.avatar,
      };

  member.model = override.model || member.model;
  member.credentialId = override.credentialId ?? member.credentialId;
  member.thinkingLevel = override.thinkingLevel || member.thinkingLevel || "off";
  member.mcpServers = Array.isArray(override.mcpServers) ? override.mcpServers : [];
  return member;
}

export function resolveRoomMember(roomId: string, memberRef: string): AgentMemberConfig | null {
  const resolveRef = "resolveRoomMemberRef" in roomStore
    ? (roomStore as any).resolveRoomMemberRef as ((roomId: string, ref: string) => RoomMemberRecord | null)
    : undefined;
  const roomMember = resolveRef?.(roomId, memberRef);
  if (roomMember) return toAgentMemberConfig(roomMember);
  return legacyResolve(roomId, memberRef);
}

export function resolveRoomMembers(roomId: string, memberRefs?: string[]): AgentMemberConfig[] {
  const getRoomMembers = "getRoomMembers" in roomStore
    ? (roomStore as any).getRoomMembers as ((roomId: string) => RoomMemberRecord[])
    : undefined;
  const roomMembers = getRoomMembers?.(roomId) || [];
  if (roomMembers.length > 0) return roomMembers.map(toAgentMemberConfig).filter((m): m is AgentMemberConfig => Boolean(m));
  return (memberRefs || []).map((name) => resolveRoomMember(roomId, name)).filter((m): m is AgentMemberConfig => Boolean(m));
}
