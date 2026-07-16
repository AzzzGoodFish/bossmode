import { createHash } from "node:crypto";
import { logger } from "../foundation/logger.js";
import { readPromptSupplement } from "../workspace/prompt-supplement-store.js";
import type { AgentDefinition, AgentMemberConfig, Room } from "../shared/types.js";

export interface CompiledPromptSection {
  id: "source-agent" | "bossmode-core" | "room-supplement" | "member-supplement";
  title: string;
  source: string;
  content: string;
  included: boolean;
  contentHash: string;
  charCount: number;
  estimatedTokens: number;
}

export interface CompiledMemberPrompt {
  agentPrompt: string;
  appendSystemPrompt: string[];
  envPrompt: string;
  fullPrompt: string;
  sections: CompiledPromptSection[];
  manifestHash: string;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function estimateTokens(content: string): number {
  return Math.round(content.length / 4);
}

function section(args: {
  id: CompiledPromptSection["id"];
  title: string;
  source: string;
  content: string;
  included?: boolean;
}): CompiledPromptSection {
  const content = args.content;
  const included = args.included ?? content.trim().length > 0;
  return {
    id: args.id,
    title: args.title,
    source: args.source,
    content,
    included,
    contentHash: hashContent(content),
    charCount: content.length,
    estimatedTokens: estimateTokens(content),
  };
}

function buildCorePrompt(args: { room: Room; member: AgentMemberConfig; agentDef: AgentDefinition; docsRoot: string }): string {
  const memberList = args.room.members.join(", ");
  const role = args.member.name !== args.agentDef.name ? ` (source role: ${args.agentDef.name})` : "";
  const leader = args.room.promptLeaderMemberId
    ? args.room.roomMembers?.find((m) => m.id === args.room.promptLeaderMemberId)?.name || "configured member"
    : "none configured";
  return `---

## Bossmode Environment

You are "${args.member.name}"${role} in a Bossmode group chat room "${args.room.name}".
Room members: ${memberList}
Working directory: ${args.room.cwd}
Room leader: ${leader}

Messages you receive are wrapped in envelopes that tell you where they came from and how to reply. Follow the envelope footer.
Communication goes exclusively through the \`chat\` tool. Bare text responses are not visible to anyone.
`;
}

function wrapSupplement(title: string, content: string): string {
  return `---\n\n## ${title}\n\n${content.trim()}\n`;
}

export function compileMemberPrompt(args: {
  room: Room;
  member: AgentMemberConfig;
  agentDef: AgentDefinition;
  docsRoot: string;
  activeTools?: string[];
}): CompiledMemberPrompt {
  const agentPrompt = args.agentDef.systemPrompt.trim() ? args.agentDef.systemPrompt : "";
  const corePrompt = buildCorePrompt(args);
  const roomSupplement = readPromptSupplement(args.room.id, "room");
  const memberSupplement = readPromptSupplement(args.room.id, "member", args.member.id);

  const sections = [
    section({ id: "source-agent", title: "Source Agent", source: `agent:${args.agentDef.name}`, content: agentPrompt, included: agentPrompt.trim().length > 0 }),
    section({ id: "bossmode-core", title: "Bossmode Core", source: "bossmode", content: corePrompt, included: true }),
    section({ id: "room-supplement", title: "Room Supplemental Prompt", source: `room:${args.room.id}`, content: roomSupplement.content, included: roomSupplement.content.trim().length > 0 }),
    section({ id: "member-supplement", title: "Member Supplemental Prompt", source: `room-member:${args.member.id}`, content: memberSupplement.content, included: memberSupplement.content.trim().length > 0 }),
  ];

  const appendSystemPrompt = [corePrompt];
  if (roomSupplement.content.trim()) appendSystemPrompt.push(wrapSupplement("Room Supplemental Prompt", roomSupplement.content));
  if (memberSupplement.content.trim()) appendSystemPrompt.push(wrapSupplement("Member Supplemental Prompt", memberSupplement.content));

  const fullPrompt = [agentPrompt, ...appendSystemPrompt].filter((part) => part.trim().length > 0).join("\n\n");
  const manifestHash = hashContent(JSON.stringify(sections.map((s) => ({ id: s.id, hash: s.contentHash, included: s.included }))));
  logger.info("agent", "compilePrompt", {
    member: args.member.name,
    memberId: args.member.id,
    agent: args.agentDef.name,
    sections: Object.fromEntries(sections.map((s) => [s.id, { chars: s.charCount, included: s.included }])),
    totalChars: fullPrompt.length,
    totalBytes: Buffer.byteLength(fullPrompt, "utf8"),
    totalTokens: `~${estimateTokens(fullPrompt)}`,
  });

  return {
    agentPrompt,
    appendSystemPrompt,
    envPrompt: corePrompt,
    fullPrompt,
    sections,
    manifestHash,
  };
}
