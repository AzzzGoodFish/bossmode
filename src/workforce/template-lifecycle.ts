/**
 * Agent template delete side-effects (0.20 S5):
 * - general / builtin immutable
 * - delete while referenced → members fall back to general + scope system warnings
 */
import { listMembers, updateMember } from "../workspace/member-registry.js";
import * as roomStore from "../workspace/room-store.js";
import { postMessage } from "../communication/message-bus.js";
import { addDmMessage } from "../workspace/dm-message-store.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { logger } from "../foundation/logger.js";

export function isImmutableTemplate(name: string): boolean {
  if (name === "general") return true;
  const def = loadAgentDefinition(name);
  return !!def?.tags?.includes("builtin");
}

export function membersReferencingTemplate(templateName: string) {
  return listMembers().filter((m) => m.agentTemplate === templateName);
}

/**
 * After a template file is removed (or before), rebind referencing members to general
 * and post a system warning in each scope they inhabit.
 */
export function fallbackMembersToGeneral(templateName: string): {
  updatedMemberIds: string[];
  warningsPosted: number;
} {
  const refs = membersReferencingTemplate(templateName);
  const updatedMemberIds: string[] = [];
  let warningsPosted = 0;
  const warning = `Template "${templateName}" is no longer available. This member has been rebound to "general". Re-assign a template in member settings if needed.`;

  for (const m of refs) {
    try {
      updateMember(m.id, { agentTemplate: "general" });
      updatedMemberIds.push(m.id);
    } catch (err) {
      logger.error("templates", "failed to rebind member to general", { memberId: m.id, error: String(err) });
      continue;
    }

    // DM scope warning
    try {
      addDmMessage(m.id, {
        sender: "system",
        content: warning,
        mentions: [],
        type: undefined,
      });
      warningsPosted += 1;
    } catch (err) {
      logger.warn("templates", "dm warning failed", { memberId: m.id, error: String(err) });
    }

    // Room scopes warning
    for (const room of roomStore.listRooms()) {
      const inGlobal = room.globalMemberIds?.includes(m.id);
      const inLegacy = roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name);
      if (!inGlobal && !inLegacy) continue;
      try {
        postMessage(room.id, "system", warning);
        warningsPosted += 1;
      } catch (err) {
        logger.warn("templates", "room warning failed", { roomId: room.id, error: String(err) });
      }
    }
  }

  return { updatedMemberIds, warningsPosted };
}

/** True if the member's agentTemplate file is missing (should show UI warning). */
export function memberTemplateWarning(agentTemplate: string): string | null {
  if (!agentTemplate) return "No template bound.";
  if (loadAgentDefinition(agentTemplate)) return null;
  return `Template "${agentTemplate}" is missing. Rebind to general or another template.`;
}
