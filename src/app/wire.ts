import { onCatalogChanged } from "../config/catalog.js";
import { refreshAllInstanceModelRegistries, notifyMemberProfileChanged } from "../agent/orchestrator/agent-manager.js";

/** Configuration reports changes; only the composition root connects them to execution. */
export function wireConfiguration(): () => void {
  return onCatalogChanged(async () => { await refreshAllInstanceModelRegistries(); });
}

import { onMemberProfileChanged } from "../member/profile.js";
import { broadcastMemberProfileChanged } from "./server/ws.js";

export function wireMemberProfiles(): () => void {
  const stopRuntime = onMemberProfileChanged(member => notifyMemberProfileChanged(member));
  const stopViews = onMemberProfileChanged(member => broadcastMemberProfileChanged({ memberId: member.id, name: member.name, title: member.title ?? null }));
  return () => { stopRuntime(); stopViews(); };
}

import { connectConversationMembers } from "../chat/conversations.js";
import { readMemberIdentity } from "../member/identity.js";
export function wireConversationMembers(): () => void {
  return connectConversationMembers(readMemberIdentity);
}
