/**
 * Final system prompt preview — byte-exact replica of what pi's AgentSession
 * assembles for a member turn (qa rc.12 finding: the real request system =
 * compiled segments + pi-appended cwd line).
 *
 * Sources of truth:
 * - role/append split mirrors pi-sdk's resolvePiSystemPromptSources
 * - skills + project context come from pi's own exported loaders
 * - the trailing cwd line and section glue replicate pi's private
 *   core/system-prompt.js buildSystemPrompt() custom-prompt branch — the
 *   deep-import contract test (tests/unit/system-prompt-final.test.ts)
 *   compares against pi's real builder byte-for-byte, so upstream format
 *   changes turn the test red instead of silently making the preview lie.
 */
import { existsSync } from "node:fs";
import {
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import { exportPiConfigForMember, resolvePiAgentDir } from "./model-credentials.js";
import { resolvePiSystemPromptSources } from "./runtime/pi-sdk.js";
import type { AgentMemberConfig } from "../shared/types.js";

export interface FinalMemberSystemPromptArgs {
  /** Scope-shaped id exactly as the runtime passes it (room:<id> / topic:<id> / dm:<memberId>). */
  scopeId: string;
  /** Session cwd exactly as the runtime passes it (room cwd / process.cwd() for DM). */
  cwd: string;
  member: AgentMemberConfig;
  /** Skill dirs/files the runtime would pass pi's loader. */
  skillPaths: string[];
  agentPrompt: string;
  appendSystemPrompt: string[];
}

/**
 * Returns the final system prompt text. The bossmode-compiled prompt is the
 * only source (piBuiltinPrompt flag retired 2026-09-04) — no null mode.
 */
export function buildFinalMemberSystemPrompt(args: FinalMemberSystemPromptArgs): string {
  const sources = resolvePiSystemPromptSources({
    agentPrompt: args.agentPrompt,
    appendSystemPrompt: args.appendSystemPrompt,
  });
  const customPrompt = sources.systemPrompt ?? "";
  const appendSection = sources.appendSystemPrompt.length > 0
    ? `\n\n${sources.appendSystemPrompt.join("\n\n")}`
    : "";

  // Agent dir resolution mirrors pi-sdk createAgent (credential override wins).
  const piConfig = args.member.model && args.member.credentialId
    ? exportPiConfigForMember({
        roomId: args.scopeId,
        memberName: args.member.id,
        modelRef: args.member.model,
        credentialId: args.member.credentialId,
      })
    : null;
  const agentDir = piConfig?.agentDir || resolvePiAgentDir(args.scopeId, args.member.id);

  const skillPaths = args.skillPaths.filter((p) => existsSync(p));
  const skills = loadSkills({ cwd: args.cwd, agentDir, skillPaths, includeDefaults: false }).skills;
  const contextFiles = loadProjectContextFiles({ cwd: args.cwd, agentDir });

  // pi core/system-prompt.js buildSystemPrompt(), customPrompt branch.
  let prompt = customPrompt + appendSection;
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path, content } of contextFiles) {
      prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }
  // "read" is always among a member's selected tools, so pi always appends
  // the skills section when any skills loaded.
  prompt += formatSkillsForPrompt(skills);
  prompt += `\nCurrent working directory: ${args.cwd.replace(/\\/g, "/")}`;
  return prompt;
}
