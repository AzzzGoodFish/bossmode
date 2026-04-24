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
  roomName: string,
  memberName?: string,
  tree?: KnowledgeTreeNode | null,
  activeRuleDocs?: string[],
  docsRoot?: string,
): AssembledPrompt {
  const agentParts: string[] = [];

  // Layer 1: Agent definition (may be empty for builtin general agent)
  if (agentDef.systemPrompt.trim()) {
    agentParts.push(agentDef.systemPrompt);
  }

  // Layer 4: Project documents index — directory tree of available docs.
  // Agents read specific documents on demand via filesystem tools.
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
    const docsPath = docsRoot || "~/.bossmode/knowledge/docs";
    agentParts.push(
      `Documents are stored at \`${docsPath}/\`. Use the read tool to load a document by path. Use write/edit tools to create or update documents.`,
      "",
      "When creating documents, include YAML frontmatter with at least a title:",
      "",
      "```",
      "---",
      "title: Document Title",
      "---",
      "```",
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
    const docsPath = docsRoot || "~/.bossmode/knowledge/docs";
    agentParts.push(`\nDocuments are stored at \`${docsPath}/\`. Use the read tool to load a document by path.`);
  }

  const agentPrompt = agentParts.join("\n");

  // Layer 5: Environment — use memberName as identity, agentDef.name as role
  const identity = memberName || agentDef.name;
  const role = memberName && memberName !== agentDef.name ? agentDef.name : undefined;
  const envPrompt = buildEnvironmentPrompt(identity, role, roomMembers, roomName);

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
export function buildEnvironmentPrompt(memberName: string, role: string | undefined, roomMembers: string[], roomName: string): string {
  const memberList = roomMembers.join(", ");
  const identity = role ? `"${memberName}" (role: ${role})` : `"${memberName}"`;
  return `
---

## Environment

You are ${identity} in a Bossmode group chat room "${roomName}".
Room members: ${memberList}

Messages you receive are wrapped in envelopes that tell you where they came from and how to reply. Follow the instructions in each envelope.

Communication goes exclusively through the \`chat\` tool. Bare text responses are not visible to anyone.
`;
}
