// System Prompt five-layer assembly — pure functions, zero side effects
import { logger } from "../foundation/logger.js";
import type { AgentDefinition, KnowledgeEntry, KnowledgeTreeNode } from "../shared/types.js";

/** Result of prompt assembly — split for runtime injection strategy */
export interface AssembledPrompt {
  /** L1 (Agent definition) + L4 (Knowledge). Empty string if agent has no systemPrompt. */
  agentPrompt: string;
  /** L5 (Environment info: member list, tools, communication rules). Always present. */
  envPrompt: string;
  /** Combined agentPrompt + envPrompt for convenience */
  fullPrompt: string;
}

/** Build agent prompt split into agentPrompt (L1+L4) and envPrompt (L5) */
export function buildAgentPrompt(
  agentDef: AgentDefinition,
  knowledgeEntries: KnowledgeEntry[],
  roomMembers: string[],
  memberName?: string,
  tree?: KnowledgeTreeNode | null,
  activeRuleDocs?: string[],
): AssembledPrompt {
  const agentParts: string[] = [];

  // Layer 1: Agent definition (may be empty for builtin general agent)
  if (agentDef.systemPrompt.trim()) {
    agentParts.push(agentDef.systemPrompt);
  }

  // Layer 4: Project documents index — directory tree of available docs.
  // Agents read specific documents on demand via query_knowledge / read_knowledge.
  // Only the INDEX is injected to keep the system prompt small (<10KB typical).
  if (tree && tree.children && tree.children.length > 0) {
    agentParts.push("---\n\n# Project Documents\n");
    agentParts.push(
      "This project has a document library. Read documents on demand — do NOT expect their full content here.\n",
    );
    agentParts.push("```");
    agentParts.push("docs/");
    renderTree(tree.children, "", agentParts, new Set(activeRuleDocs || []));
    agentParts.push("```\n");
    agentParts.push(
      "Tools:",
      "- `query_knowledge()` — returns the full tree plus doc summaries (no content).",
      "- `query_knowledge(query: \"keywords\")` — searches document titles and bodies.",
      "- `read_knowledge(path: \"folder/file.md\")` — returns a specific doc's full content.",
      "- `save_knowledge(path, title, content)` / `update_knowledge(path, title, content)` / `delete_knowledge(path)`.",
    );
    if (activeRuleDocs && activeRuleDocs.length > 0) {
      agentParts.push(
        "\nDocs marked `[rule]` above are already injected as rules in this room.",
      );
    }
  } else if (knowledgeEntries.length > 0) {
    // Fallback (should be rare): flat list when tree is unavailable
    agentParts.push("---\n\n# Project Documents\n");
    for (const entry of knowledgeEntries) agentParts.push(`- **${entry.title}**`);
    agentParts.push("\nUse `query_knowledge(\"keywords\")` to read them.");
  }

  const agentPrompt = agentParts.join("\n");

  // Layer 5: Environment — use memberName as identity, agentDef.name as role
  const identity = memberName || agentDef.name;
  const role = memberName && memberName !== agentDef.name ? agentDef.name : undefined;
  const envPrompt = buildEnvironmentPrompt(identity, role, roomMembers);

  const fullPrompt = agentPrompt ? agentPrompt + "\n" + envPrompt : envPrompt;

  const agentChars = agentDef.systemPrompt.length;
  const envChars = envPrompt.length;
  const fullPromptBytes = Buffer.byteLength(fullPrompt, "utf8");
  logger.info("agent", "assemblePrompt", {
    member: identity, agent: agentDef.name,
    layers: { agent: agentChars, env: envChars, docsCount: knowledgeEntries.length },
    totalChars: fullPrompt.length,
    totalBytes: fullPromptBytes,
    totalTokens: `~${Math.round(fullPrompt.length / 4)}`,
  });

  return { agentPrompt, envPrompt, fullPrompt };
}

/** Render directory tree as ASCII hierarchy (compact, token-efficient) */
function renderTree(
  nodes: KnowledgeTreeNode[],
  indent: string,
  out: string[],
  activeRuleDocs: Set<string>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childIndent = indent + (isLast ? "    " : "│   ");
    if (node.kind === "folder") {
      out.push(`${indent}${branch}${node.name}/`);
      if (node.children && node.children.length > 0) {
        renderTree(node.children, childIndent, out, activeRuleDocs);
      }
    } else {
      const tag = activeRuleDocs.has(node.path) ? "  [rule]" : "";
      const titleSuffix = node.title && node.title !== node.name.replace(/\.md$/i, "")
        ? `  — ${node.title}`
        : "";
      out.push(`${indent}${branch}${node.name}${titleSuffix}${tag}`);
    }
  }
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
