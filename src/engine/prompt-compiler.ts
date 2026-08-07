/**
 * Member prompt compiler — 0.20 six-segment assembly.
 * Order (fish): template identity → Core → persona → scope principles → mainline → room principles → (messages)
 * Contract + product spec v3.
 */
import { createHash } from "node:crypto";
import { logger } from "../foundation/logger.js";
import { formatBudgetHeader, readPrinciplesWithBudget } from "../workspace/principles-store.js";
import { readMainlineWithBudget, resolveMainlineRefs } from "../workspace/mainline-store.js";
import { readMemoryLayer } from "../workspace/member-memory-store.js";
import { getEnvironmentCommunicationAsset } from "../workspace/environment-communication-asset.js";
import { parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import type { AgentDefinition, AgentMemberConfig, Room } from "../shared/types.js";

export type PromptSectionId =
  | "source-agent"
  | "bossmode-core"
  | "environment-communication"
  | "persona"
  | "member-principles"
  | "member-mainline"
  | "room-principles";

export interface CompiledPromptSection {
  id: PromptSectionId;
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

/** Wrap a prompt asset with its section title and budget header (capacity is always visible). */
function wrapAsset(title: string, budgetHeader: string, content: string): string {
  return `---\n\n## ${title}\n\n${budgetHeader}\n\n${content.trim()}\n`;
}

function buildRoomCorePrompt(args: {
  room: Room;
  memberName: string;
  sourceRole: string;
  docsRoot: string;
}): string {
  const memberList = args.room.members.join(", ");
  const role = args.memberName !== args.sourceRole ? ` (source role: ${args.sourceRole})` : "";
  const leader = args.room.promptLeaderMemberId
    ? args.room.roomMembers?.find((m) => m.id === args.room.promptLeaderMemberId)?.name || "configured member"
    : "none configured";
  return `---

## Bossmode Environment

You are "${args.memberName}"${role} in a Bossmode group chat room "${args.room.name}".
Room members: ${memberList}
Working directory: ${args.room.cwd}
Room leader: ${leader}

Messages you receive are wrapped in envelopes that tell you where they came from.

## Communication

Speak with the \`chat\` tool — it is the only way your messages reach the room. Texts outside tool calls are invisible work notes, with one exception: when a reply is expected (you'll see a [REPLY EXPECTED] note) and your turn ends without a chat call, your final completed text is posted automatically.

If your activation includes an unread-messages notice, decide whether to read them (query_room_messages) before responding.

\`@name\` activates that member immediately — use \`@\` only when you need that member to respond or act right away. To simply mention a member without activating them, write the name without \`@\`.

\`@name\` queues an activation — it does not interrupt the member's current work. \`!name\` is an **urgent interrupt**: it aborts the member's current turn immediately and your message becomes the next turn. **Use \`!\` only for true emergencies** — the aborted turn may leave partial work the member must verify afterwards. For routine coordination, always prefer \`@\`.

Multiple \`@name\` in one message activate all of them at the same time — a single message cannot express "A first, then B". When work has a sequential dependency, \`@\` only the first member and let completion drive the next step: the first member hands off by \`@\`-ing the next when done, or you \`@\` the next after the first reports back.

Example:
- "developer, the RC is ready" — just a mention; developer is not activated.
- "@developer please repack the RC" — activates developer immediately, asking for action now.

## Memory

You have persistent memory assets, maintained with the read/edit/write_memory tools:

**Persona** — who you are across all scopes (global identity notes).
**Principles** — how you work in the **current scope** (this room). Store rules that save the user from correcting you twice.
**Mainline** — what you work on in the **current scope**: a "## Focus" section plus a "## Dynamic Index" of pointers.

You may **read** memory from other scopes you belong to (pass an optional scope parameter). You may only **write** the current scope's principles/mainline (and global persona).

Curate both: keep only what stays useful. Progress, results, and anything that expires belong in chat history, not memory.
`;
}

function buildDmCorePrompt(args: {
  memberName: string;
  sourceRole: string;
  activeScopes?: string[];
  docsRoot: string;
}): string {
  const role = args.memberName !== args.sourceRole ? ` (source role: ${args.sourceRole})` : "";
  const scopes = (args.activeScopes && args.activeScopes.length > 0)
    ? args.activeScopes.join(", ")
    : "dm only (no rooms yet)";
  return `---

## Bossmode Environment

You are "${args.memberName}"${role} — a digital employee in a one-to-one private chat with the user.
This is your **DM scope** (not a multi-member room).
Scopes you exist in: ${scopes}
Working directory: the user's workspace (see tool environment).

Messages you receive are wrapped in envelopes that tell you where they came from.

## Communication

Reply with the \`chat\` tool — messages go directly to this private chat. No \`@\` routing. If your turn ends without a chat call, your final text is posted automatically.

If your activation includes an unread-messages notice, decide whether to read them (query_room_messages) before responding.

## Tools unique to DM

In private chat you can manage the user's workspace of digital employees:
- Discover other members (id, name, identity)
- \`create_room\` — open a project room, optionally set room principles, invite members by id; you become the room leader
- \`edit_room\` — when you are leader of a room: rename, adjust members, update principles

## Memory

You have persistent memory assets, maintained with the read/edit/write_memory tools:

**Persona** — who you are across all scopes (global identity notes).
**Principles** — how you work in the **current scope** (this DM).
**Mainline** — what you work on in the **current scope**.

You may **read** memory, chat history, tasks, room principles, and library from any scope you belong to (optional scope parameter on query tools). You may only **write** the current scope's principles/mainline (and global persona).

Curate carefully: progress and ephemeral detail stay in chat history.
`;
}

/**
 * 0.20 scope-aware compiler.
 * Assembly order: template → Core → persona → scope principles → mainline → room principles (room only).
 */
export function compileMemberPromptForScope(args: {
  scopeId: ScopeId;
  memberId: string;
  memberName: string;
  agentDef: AgentDefinition;
  /** Required when scope is room:* */
  room?: Room | null;
  docsRoot: string;
  /** Optional list of scopes this member belongs to (for DM Core environment). */
  activeScopes?: string[];
}): CompiledMemberPrompt {
  const ref = parseScopeId(args.scopeId);
  if (!ref) throw new Error(`scope_not_found: ${args.scopeId}`);

  const agentPrompt = args.agentDef.systemPrompt.trim() ? args.agentDef.systemPrompt : "";
  const sourceRole = args.agentDef.name;

  let corePrompt: string;
  let roomPrinciplesContent = "";
  let roomPrinciplesBudgetHeader = "";
  let roomPrinciplesIncluded = false;

  if (ref.kind === "dm") {
    corePrompt = buildDmCorePrompt({
      memberName: args.memberName,
      sourceRole,
      activeScopes: args.activeScopes,
      docsRoot: args.docsRoot,
    });
  } else {
    if (!args.room) throw new Error("room required for room scope compile");
    corePrompt = buildRoomCorePrompt({
      room: args.room,
      memberName: args.memberName,
      sourceRole,
      docsRoot: args.docsRoot,
    });
    const roomPrinciples = readPrinciplesWithBudget(args.room.id, "room");
    roomPrinciplesContent = roomPrinciples.content;
    roomPrinciplesBudgetHeader = formatBudgetHeader(roomPrinciples.budget);
    roomPrinciplesIncluded = roomPrinciples.content.trim().length > 0;
  }

  // Persona (global) + scope principles/mainline from 0.20 member-memory-store.
  // Fall back to legacy room-keyed stores when new paths are empty (migration window).
  const persona = readMemoryLayer(args.memberId, "persona");
  let scopePrinciples = readMemoryLayer(args.memberId, "principles", args.scopeId);
  let scopeMainline = readMemoryLayer(args.memberId, "mainline", args.scopeId);

  if (ref.kind === "room" && args.room) {
    if (!scopePrinciples.content.trim()) {
      const legacy = readPrinciplesWithBudget(args.room.id, "member", args.memberId);
      if (legacy.content.trim()) {
        scopePrinciples = { content: legacy.content, meta: { length: legacy.content.length, budget: legacy.budget } };
      }
    }
    if (!scopeMainline.content.trim()) {
      const legacy = readMainlineWithBudget(args.room.id, args.memberId);
      if (legacy.content.trim()) {
        const resolved = resolveMainlineRefs(args.room.id, legacy.content);
        scopeMainline = { content: resolved, meta: { length: resolved.length, budget: legacy.budget } };
      }
    } else if (args.room) {
      // Resolve docs/task refs when we have a room context
      scopeMainline = {
        ...scopeMainline,
        content: resolveMainlineRefs(args.room.id, scopeMainline.content),
      };
    }
  }

  // 0.20 experience ③: global user-editable Environment & Communication asset
  // (shared framing + communication style, spliced into both room and DM Core
  // variants — user file when edited, code default otherwise).
  const ecAsset = getEnvironmentCommunicationAsset();

  const sections = [
    section({ id: "source-agent", title: "Source Agent", source: `agent:${args.agentDef.name}`, content: agentPrompt, included: agentPrompt.trim().length > 0 }),
    section({ id: "bossmode-core", title: "Bossmode Core", source: "bossmode", content: corePrompt, included: true }),
    section({ id: "environment-communication", title: "Environment & Communication", source: "asset:environment-communication", content: ecAsset.content, included: ecAsset.content.trim().length > 0 }),
    section({ id: "persona", title: "Persona", source: `member:${args.memberId}`, content: persona.content, included: persona.content.trim().length > 0 }),
    section({ id: "member-principles", title: "Scope Principles", source: `member:${args.memberId}:${args.scopeId}`, content: scopePrinciples.content, included: scopePrinciples.content.trim().length > 0 }),
    section({ id: "member-mainline", title: "Scope Mainline", source: `member:${args.memberId}:${args.scopeId}`, content: scopeMainline.content, included: scopeMainline.content.trim().length > 0 }),
    section({ id: "room-principles", title: "Room Principles", source: ref.kind === "room" ? `room:${ref.roomId}` : "none", content: roomPrinciplesContent, included: roomPrinciplesIncluded }),
  ];

  const appendSystemPrompt: string[] = [corePrompt];
  if (ecAsset.content.trim()) {
    appendSystemPrompt.push(ecAsset.content.trim());
  }
  if (persona.content.trim()) {
    appendSystemPrompt.push(wrapAsset("Persona", formatBudgetHeader(persona.meta.budget), persona.content));
  }
  if (scopePrinciples.content.trim()) {
    appendSystemPrompt.push(wrapAsset("Scope Principles", formatBudgetHeader(scopePrinciples.meta.budget), scopePrinciples.content));
  }
  if (scopeMainline.content.trim()) {
    appendSystemPrompt.push(wrapAsset("Scope Mainline", formatBudgetHeader(scopeMainline.meta.budget), scopeMainline.content));
  }
  if (roomPrinciplesIncluded) {
    appendSystemPrompt.push(wrapAsset("Room Principles", roomPrinciplesBudgetHeader, roomPrinciplesContent));
  }

  const fullPrompt = [agentPrompt, ...appendSystemPrompt].filter((part) => part.trim().length > 0).join("\n\n");
  const manifestHash = hashContent(JSON.stringify(sections.map((s) => ({ id: s.id, hash: s.contentHash, included: s.included }))));
  logger.info("agent", "compilePrompt", {
    member: args.memberName,
    memberId: args.memberId,
    scopeId: args.scopeId,
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

/**
 * Backward-compatible room compiler used by existing room activation paths.
 * Delegates to scope-aware compiler with room:<id> scope.
 */
export function compileMemberPrompt(args: {
  room: Room;
  member: AgentMemberConfig;
  agentDef: AgentDefinition;
  docsRoot: string;
  activeTools?: string[];
}): CompiledMemberPrompt {
  const scopeId: ScopeId = `room:${args.room.id}`;
  return compileMemberPromptForScope({
    scopeId,
    memberId: args.member.id,
    memberName: args.member.name,
    agentDef: args.agentDef,
    room: args.room,
    docsRoot: args.docsRoot,
  });
}
