// System Prompt five-layer assembly — pure functions, zero side effects
import { logger } from "../foundation/logger.js";
import type { AgentDefinition, KnowledgeEntry } from "../shared/types.js";

/** Build the full agent prompt: Layer 1 (agent def) + Layer 4 (knowledge) + Layer 5 (env) */
export function buildAgentPrompt(
  agentDef: AgentDefinition,
  knowledgeEntries: KnowledgeEntry[],
  roomMembers: string[],
  memberName?: string,
): string {
  const parts: string[] = [];

  // Layer 1: Agent definition
  parts.push(agentDef.systemPrompt);

  // Layer 4: Knowledge
  if (knowledgeEntries.length > 0) {
    parts.push("---\n\n# Project Knowledge\n");
    for (const entry of knowledgeEntries) {
      parts.push(`## ${entry.title}\n\n${entry.content}\n`);
    }
  }

  // Layer 5: Environment — use memberName as identity, agentDef.name as role
  const identity = memberName || agentDef.name;
  const role = memberName && memberName !== agentDef.name ? agentDef.name : undefined;
  parts.push(buildEnvironmentPrompt(identity, role, roomMembers));

  const fullPrompt = parts.join("\n");
  const agentChars = agentDef.systemPrompt.length;
  const knowledgeChars = knowledgeEntries.reduce((n, e) => n + e.content.length + e.title.length, 0);
  const envChars = fullPrompt.length - agentChars - knowledgeChars;
  logger.info("agent", "assemblePrompt", {
    member: identity, agent: agentDef.name,
    layers: { agent: agentChars, knowledge: knowledgeChars, env: envChars },
    totalTokens: `~${Math.round(fullPrompt.length / 4)}`,
  });

  return fullPrompt;
}

/** Build environment info section (Layer 5) */
export function buildEnvironmentPrompt(memberName: string, role: string | undefined, roomMembers: string[]): string {
  const memberList = roomMembers.join(", ");
  const identity = role ? `"${memberName}" (role: ${role})` : `"${memberName}"`;
  return `
---

## Environment

You are ${identity} in a Bossmode group chat room.
Room members: ${memberList}

## Available Tools

- **chat** — Post a message.
  - \`target: "room"\` (default): visible to everyone in the group chat. **Use this for all normal responses.**
  - \`target: "user"\`: private reply, only the user sees it. **Only use this when responding to [Private instruction from user] messages.**
  - \`mentions\`: optional array of agent names to @activate
- **query_room_messages** — Read recent group chat messages
- **save_knowledge** / **query_knowledge** — Read/write project knowledge base

## Communication Rules

- When activated by an @ mention in the group chat, **always reply with \`target: "room"\`**. Your response should be visible to everyone.
- When you receive a message prefixed with \`[Private instruction from user]\`, reply with \`target: "user"\`. This is a private conversation — do not share it in the group chat.
- Your direct text responses are NOT visible anywhere — only chat tool calls are. Always use the chat tool to communicate.
`;
}
