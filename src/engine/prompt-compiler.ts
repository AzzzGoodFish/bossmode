import { createHash } from "node:crypto";
import { logger } from "../foundation/logger.js";
import { formatBudgetHeader, readPrinciplesWithBudget } from "../workspace/principles-store.js";
import { readMainlineWithBudget, resolveMainlineRefs } from "../workspace/mainline-store.js";
import type { AgentDefinition, AgentMemberConfig, Room } from "../shared/types.js";

export interface CompiledPromptSection {
  id: "source-agent" | "bossmode-core" | "room-principles" | "member-principles" | "member-mainline";
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

Messages you receive are wrapped in envelopes that tell you where they came from.
Communication goes exclusively through the \`chat\` tool — every reply goes to the room. Bare text responses are not visible to anyone.
`;
}

/** Wrap a prompt asset with its section title and budget header (capacity is always visible). */
function wrapAsset(title: string, budgetHeader: string, content: string): string {
  return `---\n\n## ${title}\n\n${budgetHeader}\n\n${content.trim()}\n`;
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
  const roomPrinciples = readPrinciplesWithBudget(args.room.id, "room");
  const memberPrinciples = readPrinciplesWithBudget(args.room.id, "member", args.member.id);
  const memberMainline = readMainlineWithBudget(args.room.id, args.member.id);
  const mainlineContent = memberMainline.content.trim() ? resolveMainlineRefs(args.room.id, memberMainline.content) : memberMainline.content;

  const sections = [
    section({ id: "source-agent", title: "Source Agent", source: `agent:${args.agentDef.name}`, content: agentPrompt, included: agentPrompt.trim().length > 0 }),
    section({ id: "bossmode-core", title: "Bossmode Core", source: "bossmode", content: corePrompt, included: true }),
    section({ id: "room-principles", title: "Room Principles", source: `room:${args.room.id}`, content: roomPrinciples.content, included: roomPrinciples.content.trim().length > 0 }),
    section({ id: "member-principles", title: "Member Principles", source: `room-member:${args.member.id}`, content: memberPrinciples.content, included: memberPrinciples.content.trim().length > 0 }),
    section({ id: "member-mainline", title: "Member Mainline", source: `room-member:${args.member.id}`, content: mainlineContent, included: mainlineContent.trim().length > 0 }),
  ];

  const appendSystemPrompt = [corePrompt];
  if (roomPrinciples.content.trim()) appendSystemPrompt.push(wrapAsset("Room Principles", formatBudgetHeader(roomPrinciples.budget), roomPrinciples.content));
  if (memberPrinciples.content.trim()) appendSystemPrompt.push(wrapAsset("Member Principles", formatBudgetHeader(memberPrinciples.budget), memberPrinciples.content));
  if (mainlineContent.trim()) appendSystemPrompt.push(wrapAsset("Member Mainline", formatBudgetHeader(memberMainline.budget), mainlineContent));

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
