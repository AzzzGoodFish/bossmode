import { loadAgentDefinition } from "./agent-store.js";
import { getMemberByName } from "./member-store.js";
import { getRoom } from "../workspace/room-store.js";
import type { AgentMemberConfig } from "../shared/types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export function resolveRoomMember(roomId: string, memberName: string): AgentMemberConfig | null {
  const base = getMemberByName(memberName);
  const agentDef = loadAgentDefinition(base?.agent || memberName);
  if (!base && !agentDef) return null;

  const override = getRoom(roomId)?.memberOverrides?.[memberName] || {};
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

  member.model = override.model || member.model || agentDef?.model || DEFAULT_MODEL;
  member.credentialId = override.credentialId ?? member.credentialId;
  member.thinkingLevel = override.thinkingLevel || member.thinkingLevel || "off";
  member.mcpServers = Array.isArray(override.mcpServers) ? override.mcpServers : [];
  return member;
}

export function resolveRoomMembers(roomId: string, memberNames: string[]): AgentMemberConfig[] {
  return memberNames.map((name) => resolveRoomMember(roomId, name)).filter((m): m is AgentMemberConfig => Boolean(m));
}
