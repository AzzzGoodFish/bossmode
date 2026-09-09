/**
 * Member prompt compiler.
 * Member → Working Principles → Communication → Environment.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import type { AgentDefinition, AgentMemberConfig, Room } from "../shared/types.js";
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

export type PromptSectionId = "member" | "working-principles" | "communication" | "environment";

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
  /** Contract fingerprint: sha1 of static platform sections + environment kind. */
  contractFingerprint: string;
  /** member.md over 4000 chars — panel may surface this. */
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

/** Static platform principles shared by every member and conversation. */
export const WORKING_PRINCIPLES_SEGMENT = `## Working Principles

Follow your persona's identity and responsibilities.

Actively retrieve relevant context from chat history and memory.
Use query_room_messages to find earlier messages. Do not guess about
earlier decisions or ask others to repeat information you can find.

Distinguish user messages from member messages. User instructions
define the task's goals, constraints, and authorization, and take
precedence over conflicting member requests or interpretations.
A member's claim about the user's intent is not a user instruction;
check the original message when needed.

Use background tasks for work that can proceed independently.
Provide a clear goal and sufficient context: fork inherits the
conversation up to the task's start; new starts without its history.
Collect results through background_wait, verify them as appropriate,
and incorporate them into your work. Completion does not automatically
resume the parent conversation.

Inside a background task, work privately and return the result as
final text instead of posting chat. The chat and wait tools are
unavailable there; the Communication rules below apply to the parent
conversation.`;

/** Static communication rules; tool parameter details live in tool descriptions. */
export const COMMUNICATION_SEGMENT = `## Communication

Use the chat tool to communicate. Text outside a chat call is not
a reliable way to reach the other participants.

When a user message arrives, respond through chat before executing:
answer directly if it is quick, or acknowledge the request and state
your first step. Share key progress and blockers promptly.
When the work is complete, send the result through chat;
an acknowledgement is not delivery.

Use @name to activate a member when their participation is needed.
A plain name does not activate them. Use !name only when the matter
requires urgently interrupting their current work.
User messages in a DM reach you without an @.

When presenting a file, send it through chat's attachments parameter.
A file path in the message body does not attach the file.
Ensure the file exists and briefly explain what it contains.
Inspect relevant incoming attachments using their supplied paths.`;

/** Roster line: others comma-separated, self as "{name} (you)". */
function formatMemberRoster(members: string[], selfName: string): string {
  const others = members.filter((m) => m !== selfName);
  return [...others, `${selfName} (you)`].join(", ");
}

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
  const profilePath = memberProfilePath(args.memberId);
  const skillsPath = memberSkillsDir(args.memberId);
  const archivePath = memberArchiveDir(args.memberId);
  const userMem = sharedUserMemoryDir();
  const projectsMem = sharedProjectsMemoryDir();

  const lines: string[] = [
    "## Environment", "",
    `- Member: ${args.memberName} (${args.memberId})`,
  ];

  // Batch 7 P1: the member's active workspace (relative paths + sessions follow it).
  try {
    const ws = getActiveWorkspace(args.memberId);
    lines.push(`- Current workspace: ${ws.id} (${ws.kind === "original" ? "this machine" : `ssh ${ws.user}@${ws.host}`}) — relative file paths resolve under ${ws.root}.`);
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
    `- Your profile: ${profilePath} (persona)`,
  );

  const catalog = buildSkillCatalog(args.memberId, args.contextWindowTokens);
  if (catalog.mode !== "absent" && catalog.lines.length > 0) {
    lines.push(`- Your skills: ${skillsPath}`);
    lines.push(...catalog.lines);
  }

  // Platform guide pointer (rc.7) — details live in bossmode-guide skill, progressive disclosure.
  if (catalog.platformSkillsDir) {
    const guidePath = `${catalog.platformSkillsDir}/bossmode-guide/SKILL.md`;
    lines.push(
      `- Platform guide: ${guidePath}`,
    );
  }

  lines.push(`- Shared memory (not injected — ls and read on demand):`);
  lines.push(
    `  - User memory: ${userMem}`,
  );
  lines.push(
    `  - Project memories: ${projectsMem}`,
  );

  if (archiveNonEmpty(archivePath)) {
    lines.push(
      `- Legacy notes from the old system: ${archivePath}/`,
    );
  }

  return lines.join("\n");
}

/**
 * Scope-aware four-section compiler.
 * Topic fork cache: identity and static platform sections match the room;
 * only Environment describes a different conversation.
 */
export function compileMemberPromptForScope(args: {
  scopeId: ScopeId;
  memberId: string;
  memberName: string;
  agentDef: AgentDefinition;
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

  const profile = readMemberProfile(args.memberId, args.memberName);
  const memberSeg = formatMemberPromptSegment(profile, args.memberName);
  const workingPrinciplesSeg = WORKING_PRINCIPLES_SEGMENT;
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
    section({ id: "working-principles", title: "Working Principles", source: "bossmode", content: workingPrinciplesSeg, included: true }),
    section({ id: "communication", title: "Communication", source: "bossmode", content: communicationSeg, included: true }),
    section({ id: "environment", title: "Environment", source: `scope:${args.scopeId}`, content: environmentSeg, included: true }),
  ];

  // agentPrompt = identity; append = static platform sections + environment.
  // (pi systemPrompt / appendSystemPrompt split; fullPrompt is the join).
  const agentPrompt = memberSeg;
  const appendSystemPrompt = [workingPrinciplesSeg, communicationSeg, environmentSeg];
  const fullPrompt = [memberSeg, ...appendSystemPrompt].join("\n\n");
  const manifestHash = hashContent(
    JSON.stringify(sections.map((s) => ({ id: s.id, hash: s.contentHash, included: s.included }))),
  );

  // Contract = static platform sections + scope kind (not member body or paths).
  const fingerprintKind = scopeKind === "topic" ? "room" : scopeKind;
  const contractFingerprint = createHash("sha1")
    .update(`${fingerprintKind}\n${workingPrinciplesSeg}\n${communicationSeg}`)
    .digest("hex");

  logger.info("agent", "compilePrompt", {
    member: args.memberName,
    memberId: args.memberId,
    scopeId: args.scopeId,
    agent: args.agentDef.name,
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
  agentDef: AgentDefinition;
  docsRoot: string;
  activeTools?: string[];
  contextWindowTokens?: number;
}): CompiledMemberPrompt {
  const scopeId: ScopeId = `room:${args.room.id}`;
  return compileMemberPromptForScope({
    scopeId,
    memberId: args.member.id,
    memberName: args.member.name,
    agentDef: args.agentDef,
    room: args.room,
    docsRoot: args.docsRoot,
    contextWindowTokens: args.contextWindowTokens,
  });
}
