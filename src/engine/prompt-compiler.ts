/**
 * Member prompt compiler — identity/memory redesign batch 1.
 * Three segments: Member → Communication → Environment.
 * Spec: docs/bossmode/architecture/spec-member-identity-three-memory-impl-v1.md
 * Sketch: docs/bossmode/architecture/member-system-prompt-sketch-v2.md
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { getBossmodeDir } from "../shared/config.js";
import { parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import type { AgentMemberConfig, Room } from "../shared/types.js";
import {
  formatMemberPromptSegment,
  memberArchiveDir,
  memberProfilePath,
  memberSkillsDir,
  readMemberProfile,
  sharedProjectsMemoryDir,
  sharedUserMemoryDir,
} from "../workspace/member-profile.js";
import { getActiveWorkspace } from "../workspace/workspace-registry.js";
import { buildSkillCatalog } from "./skill-catalog.js";

export type PromptSectionId = "member" | "communication" | "environment";

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
  /** Contract fingerprint: sha1 of code-owned parts (Communication + env kind). */
  contractFingerprint: string;
  /** persona.md over 4000 chars — panel may surface this. */
  profileOverBudget?: boolean;
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

/** Communication segment — full member-identical text (sketch-v2 / writter). */
export const COMMUNICATION_SEGMENT = `## Communication

The chat tool is the only way your messages reach the room. Text you
write outside a chat call is a private scratchpad — nobody sees it. A
reply counts only when it goes out as a chat call. (One safety net: if
a reply was expected and your turn ends without a chat call, your final
text is posted automatically — a net, not a habit.)

Reply first. When the user or another member reaches you, your first
move is a chat reply, before any tool call: the direct answer if it's
quick, or one line acknowledging the request plus your first step if
it's real work. Never open with silent tool calls — to them that's
indistinguishable from a frozen app.

Ack ≠ delivery. Saying "on it" never counts as reporting back. If the
turn produced something they're waiting on, the last thing you do before
ending the turn is chat the result.

Room history is memory. The injected messages are only the latest
window — the full record is queryable with query_room_messages. When a
message leans on earlier discussion you don't have (a decision, an
error, a file path, a promise), read the record first: from_seq for a
window, query to search. Answer from the record, not from assumption —
and never ask the room to repeat what it already said.

Keep them posted on beats, not mechanics. On multi-step work, send a
short line at each meaningful beat (a finding, a blocker, a decision) —
never a long silent stretch, never a play-by-play of commands.

Write like texting, not a memo:
- One or two sentences by default; match their length; go shorter when
  the moment is light.
- Two or three beats → two or three short chat calls, not one welded
  paragraph. Prose over bullet lists unless they asked for a list.
- Lead with the thing itself — no "Done —", no "Quick version:", no
  filler closings, no unprompted caveats.

Tone: a warm, sharp colleague, not a help desk. Plain everyday words.
No "Certainly", no "I'd be happy to". Prefer periods and commas; keep
dashes for when nothing else fits. Mirror their emoji — if they rarely
use them, you don't.

Room mechanics:
- @name activates that member; a plain name is just a mention. !name is
  an urgent interrupt — emergencies only. Multiple @ activate all at
  once; for "A then B", @ only the first and let them hand off.
- In a DM every user message reaches you directly — no @ needed.
- need_response lists who must reply; omit it for FYI.
- reply_to quotes a previous message (msg:#<seq>) — quote, don't restate.

Internal operations are the one exception. recall, memorize and other
background tasks run in a private session of yours: there you do not
post chat — the chat and wait tools are unavailable. Do the work with
your file and query tools and return the answer as your final text;
it is delivered as the task result through background_wait.`;

/** Roster line: others comma-separated, self as "{name} (you)". */
function formatMemberRoster(members: string[], selfName: string): string {
  const others = members.filter((m) => m !== selfName);
  return [...others, `${selfName} (you)`].join(", ");
}

const TOOLS_AND_ATTACHMENTS_LINES = `- Messages arrive wrapped in envelopes with sender and sequence number.
  Attachments land in the room's attachment store; reference them by path.
  Long content belongs in the Library as a document, with a chat summary
  in the room.`;

function archiveNonEmpty(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const names = readdirSync(dir);
    return names.some((n) => {
      try {
        return statSync(join(dir, n)).isFile() || statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function buildEnvironmentSegment(args: {
  scopeKind: "room" | "dm" | "topic";
  memberId: string;
  memberName: string;
  room?: Room | null;
  topicTitle?: string | null;
  contextWindowTokens: number;
}): string {
  const boss = getBossmodeDir();
  const profilePath = memberProfilePath(args.memberId);
  const skillsPath = memberSkillsDir(args.memberId);
  const archivePath = memberArchiveDir(args.memberId);
  const userMem = sharedUserMemoryDir();
  const projectsMem = sharedProjectsMemoryDir();

  const lines: string[] = ["## Environment", ""];

  // Batch 7 P1: the member's active workspace (relative paths + sessions follow it).
  try {
    const ws = getActiveWorkspace(args.memberId);
    lines.push(`- Current workspace: ${ws.id} (${ws.kind === "original" ? "this machine" : `ssh ${ws.user}@${ws.host}`}) — relative file paths resolve under ${ws.root}. Use workspace_list / workspace_use to switch.`);
  } catch {
    lines.push(`- Current workspace: original (this machine) — relative file paths resolve under your member directory.`);
  }

  if (args.scopeKind === "dm") {
    lines.push(`- You are in a private chat with the user.`);
  } else if (args.scopeKind === "topic") {
    const roomName = args.room?.name || "room";
    const title = args.topicTitle || "topic";
    const roster = formatMemberRoster(args.room?.members || [], args.memberName);
    lines.push(
      `- You are in topic "${title}" of room "${roomName}". Members: ${roster}.`,
    );
  } else {
    const roomName = args.room?.name || "room";
    const roster = formatMemberRoster(args.room?.members || [], args.memberName);
    lines.push(
      `- You are in room "${roomName}" — a shared workspace. Members: ${roster}.`,
    );
  }

  lines.push(
    `- Your profile: ${profilePath} — this file IS your persona. It is free-form Markdown with no frontmatter or required sections. When the user's feedback teaches you something lasting, update this file with the edit tool.`,
  );

  const catalog = buildSkillCatalog(args.memberId, args.contextWindowTokens);
  if (catalog.mode !== "absent" && catalog.lines.length > 0) {
    lines.push(`- Your skills: ${skillsPath}`);
    lines.push(...catalog.lines);
    lines.push(
      `  Read a skill's SKILL.md with the read tool when you need it. To make a recurring procedure reusable, write it as a new SKILL.md under your skills/ directory.`,
    );
  }

  // Platform guide pointer (rc.7) — details live in bossmode-guide skill, progressive disclosure.
  if (catalog.platformSkillsDir) {
    const guidePath = `${catalog.platformSkillsDir}/bossmode-guide/SKILL.md`;
    lines.push(
      `- When unsure how to manage your identity, memory dirs, or skills, read the platform guide: ${guidePath}`,
    );
  }

  lines.push(`- Shared memory (not injected — ls and read on demand):`);
  lines.push(
    `  - User memory: ${userMem} — who the user is, preferences, working habits. One shared record; keep it current when you learn something durable about the user.`,
  );
  lines.push(
    `  - Project memories: ${projectsMem} — one folder per project. ls it before starting project work; write back what the project learns.`,
  );

  if (archiveNonEmpty(archivePath)) {
    lines.push(
      `- Legacy notes from the old system: ${archivePath}/. When relevant, read them and fold what is still true into your persona.md or the shared memory dirs; remove each file once folded.`,
    );
  }

  lines.push(TOOLS_AND_ATTACHMENTS_LINES);

  return lines.join("\n");
}

/**
 * Scope-aware three-segment compiler.
 * Topic fork cache: Member + Communication byte-identical to room; only Environment first line differs.
 */
export function compileMemberPromptForScope(args: {
  scopeId: ScopeId;
  memberId: string;
  memberName: string;
  room?: Room | null;
  docsRoot: string;
  activeScopes?: string[];
  /** Model context window for skill budget (tokens). Default 128000. */
  contextWindowTokens?: number;
  topicTitle?: string | null;
}): CompiledMemberPrompt {
  const ref = parseScopeId(args.scopeId);
  if (!ref) throw new Error(`scope_not_found: ${args.scopeId}`);

  const scopeKind: "room" | "dm" | "topic" =
    ref.kind === "dm" ? "dm" : ref.kind === "topic" ? "topic" : "room";

  if ((scopeKind === "room" || scopeKind === "topic") && !args.room) {
    throw new Error("room required for room/topic scope compile");
  }

  const profile = readMemberProfile(args.memberId);
  const memberSeg = formatMemberPromptSegment(profile, args.memberName);
  const communicationSeg = COMMUNICATION_SEGMENT;
  const environmentSeg = buildEnvironmentSegment({
    scopeKind,
    memberId: args.memberId,
    memberName: args.memberName,
    room: args.room,
    topicTitle: args.topicTitle,
    contextWindowTokens: args.contextWindowTokens ?? 128_000,
  });

  const sections = [
    section({ id: "member", title: "Member", source: `member:${args.memberId}`, content: memberSeg, included: true }),
    section({ id: "communication", title: "Communication", source: "bossmode", content: communicationSeg, included: true }),
    section({ id: "environment", title: "Environment", source: `scope:${args.scopeId}`, content: environmentSeg, included: true }),
  ];

  // agentPrompt = identity (Member); append = Communication + Environment
  // (pi systemPrompt / appendSystemPrompt split; fullPrompt is the join).
  const agentPrompt = memberSeg;
  const appendSystemPrompt = [communicationSeg, environmentSeg];
  const fullPrompt = [memberSeg, communicationSeg, environmentSeg].join("\n\n");
  const manifestHash = hashContent(
    JSON.stringify(sections.map((s) => ({ id: s.id, hash: s.contentHash, included: s.included }))),
  );

  // Contract = code-owned Communication + scope kind (not member body, not paths).
  const fingerprintKind = scopeKind === "topic" ? "room" : scopeKind;
  const contractFingerprint = createHash("sha1")
    .update(`${fingerprintKind}\n${COMMUNICATION_SEGMENT}`)
    .digest("hex");

  logger.info("agent", "compilePrompt", {
    member: args.memberName,
    memberId: args.memberId,
    scopeId: args.scopeId,
    sections: Object.fromEntries(sections.map((s) => [s.id, { chars: s.charCount, included: s.included }])),
    totalChars: fullPrompt.length,
    totalBytes: Buffer.byteLength(fullPrompt, "utf8"),
    totalTokens: `~${estimateTokens(fullPrompt)}`,
    profileOverBudget: profile.overBudget || undefined,
  });

  return {
    agentPrompt,
    appendSystemPrompt,
    envPrompt: environmentSeg,
    fullPrompt,
    sections,
    manifestHash,
    contractFingerprint,
    ...(profile.overBudget ? { profileOverBudget: true } : {}),
  };
}

/**
 * Room compiler — delegates to scope-aware compiler with room:<id>.
 */
export function compileMemberPrompt(args: {
  room: Room;
  member: AgentMemberConfig;
  docsRoot: string;
  activeTools?: string[];
  contextWindowTokens?: number;
}): CompiledMemberPrompt {
  const scopeId: ScopeId = `room:${args.room.id}`;
  return compileMemberPromptForScope({
    scopeId,
    memberId: args.member.id,
    memberName: args.member.name,
    room: args.room,
    docsRoot: args.docsRoot,
    contextWindowTokens: args.contextWindowTokens,
  });
}
