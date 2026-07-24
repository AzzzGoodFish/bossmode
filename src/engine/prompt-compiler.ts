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

## Communication

Two ways to speak in the room: (1) call the \`chat\` tool; (2) write \`[room]\` on its own line — everything after it is posted to the room, everything before it stays private. Text without the marker never reaches the room.

Use **exactly one** channel per message — either the \`chat\` tool or the \`[room]\` marker, never both. The same content sent through both channels is posted to the room twice.

Example:
\`\`\`
Let me check the logs first...   ← not posted
[room]
Found it — the failure is in the token refresh.   ← posted
\`\`\`

\`@name\` activates that member immediately — use \`@\` only when you need that member to respond or act right away. To simply mention a member without activating them, write the name without \`@\`.

Multiple \`@name\` in one message activate all of them at the same time — a single message cannot express "A first, then B". When work has a sequential dependency, \`@\` only the first member and let completion drive the next step: the first member hands off by \`@\`-ing the next when done, or you \`@\` the next after the first reports back.

Example:
- "developer, the RC is ready" — just a mention; developer is not activated.
- "@developer please repack the RC" — activates developer immediately, asking for action now.

## Memory

You have two persistent memory assets, maintained with the read/edit/write_memory tools:

**Principles** — how you work: durable behavior and communication norms that evolve with the user's feedback. Store rules that save the user from correcting you twice.
  Not this: "Shipped v2.3 on Monday" — it expires; chat history holds it.
  This: "The user prefers conclusion-first updates; details only on request."

**Mainline** — what you work on: a "## Focus" section for long-lived domain knowledge, plus a "## Dynamic Index" of pointers (docs/..., task:<id>, msg:#<n>) to the few assets you keep returning to this phase — one line of context each, never the content itself.
  Not this: a full QA report pasted inline.
  This: "- task:a1b2c3d4 — tool-description simplification (next release batch)"

Curate both: keep only what stays useful. Progress, results, and anything that expires belong in chat history, not memory.
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
    section({ id: "member-principles", title: "Member Principles", source: `room-member:${args.member.id}`, content: memberPrinciples.content, included: memberPrinciples.content.trim().length > 0 }),
    section({ id: "member-mainline", title: "Member Mainline", source: `room-member:${args.member.id}`, content: mainlineContent, included: mainlineContent.trim().length > 0 }),
    section({ id: "room-principles", title: "Room Principles", source: `room:${args.room.id}`, content: roomPrinciples.content, included: roomPrinciples.content.trim().length > 0 }),
  ];

  const appendSystemPrompt = [corePrompt];
  if (memberPrinciples.content.trim()) appendSystemPrompt.push(wrapAsset("Member Principles", formatBudgetHeader(memberPrinciples.budget), memberPrinciples.content));
  if (mainlineContent.trim()) appendSystemPrompt.push(wrapAsset("Member Mainline", formatBudgetHeader(memberMainline.budget), mainlineContent));
  if (roomPrinciples.content.trim()) appendSystemPrompt.push(wrapAsset("Room Principles", formatBudgetHeader(roomPrinciples.budget), roomPrinciples.content));

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
