/** pi resource adapter: prompt sources, member asset discovery, hosted MCP wiring.
 * Everything here is SDK-facing; it never imports chat or scheduler. */
import { existsSync } from "node:fs";
import { builtinMcpAdapterPath, discoverMemberExtensionEntries } from "../../member/extensions.js";
export { discoverMemberExtensionEntries } from "../../member/extensions.js";
import { memberExtensionsDir, memberSkillsDir } from "../../files/layout.js";
import { ensureBossmodeMcpDirs, getBossmodeMcpRuntimeDir, writeMemberScopedMcpConfig } from "../../member/mcp.js";
import { logger } from "../../kernel/logger.js";
import { DefaultResourceLoader, type ResourceLoader, type AgentSession, formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";

// pi SDK prompt utilities — runtime adapter zone. Re-exported so prompt assembly never imports @earendil-works/* directly.
export { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";

/**
 * Resolve systemPrompt vs appendSystemPrompt for pi DefaultResourceLoader.
 * The bossmode-compiled prompt is the only source (fish 2026-09-04: the
 * piBuiltinPrompt flag is retired) — pi's built-in system prompt never loads.
 * Exported for unit tests.
 */
export function resolvePiSystemPromptSources(args: {
  agentPrompt: string;
  appendSystemPrompt: string[];
}): { systemPrompt: string | undefined; appendSystemPrompt: string[] } {
  const rolePrompt = args.agentPrompt.trim();
  const appends = args.appendSystemPrompt.filter((v) => !!v && v.trim().length > 0);
  return {
    systemPrompt: rolePrompt || undefined,
    appendSystemPrompt: appends,
  };
}
/** Prompt sources are owned by Bossmode; resource discovery stays in the SDK. */
export class BossmodeResourceLoader implements ResourceLoader {
  private delegate: DefaultResourceLoader;
  private promptSources: ReturnType<typeof resolvePiSystemPromptSources>;

  constructor(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    sources: ReturnType<typeof resolvePiSystemPromptSources>,
  ) {
    this.delegate = new DefaultResourceLoader(options);
    this.promptSources = { ...sources, appendSystemPrompt: [...sources.appendSystemPrompt] };
  }

  async reload(options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    await this.delegate.reload(options);
  }

  getExtensions() { return this.delegate.getExtensions(); }
  getSkills() { return this.delegate.getSkills(); }
  getPrompts() { return this.delegate.getPrompts(); }
  getThemes() { return this.delegate.getThemes(); }
  getAgentsFiles() { return this.delegate.getAgentsFiles(); }
  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void { this.delegate.extendResources(paths); }

  setPromptSources(sources: ReturnType<typeof resolvePiSystemPromptSources>): void {
    this.promptSources = { ...sources, appendSystemPrompt: [...sources.appendSystemPrompt] };
  }

  getSystemPrompt(): string | undefined {
    return this.promptSources.systemPrompt;
  }

  /** Bossmode prompt sources are in-memory (compiled per scope); there is no file backing. */
  getSystemPromptSource(): { path: string } | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [...this.promptSources.appendSystemPrompt];
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return [];
  }
}

export interface McpRuntimeSettings {
  enabled: boolean;
  adapterPath?: string;
  configPath: string;
  runtimeDir: string;
  serverNames: string[];
  dispose(): void;
}
/** Batch 6 §1: member-dir assets that join the loader paths (create + reload
 * both call this — skills dir §1.1, extensions dir §1.3 expanded to file
 * entries, present = included). */
export function memberDirLoaderAssetPaths(memberId: string): { skills: string[]; extensions: string[] } {
  const skillsDir = memberSkillsDir(memberId);
  return {
    skills: existsSync(skillsDir) ? [skillsDir] : [],
    extensions: discoverMemberExtensionEntries(memberExtensionsDir(memberId)),
  };
}

export function resolveMcpRuntimeSettings(args: { roomId: string; member: AgentMemberConfig }): McpRuntimeSettings {
  // Member configuration is SQL-owned; the temporary file is derived adapter input.
  // The adapter is platform infrastructure, including for an empty configuration.
  const runtimeDir = getBossmodeMcpRuntimeDir();
  const adapterPath = builtinMcpAdapterPath();
  if (!existsSync(adapterPath)) {
    throw new Error(`MCP adapter not found at ${adapterPath}. Run git submodule update --init --recursive.`);
  }
  ensureBossmodeMcpDirs();
  const mcpRoomId = args.roomId;
  const scoped = writeMemberScopedMcpConfig({ roomId: mcpRoomId, memberId: args.member.id });
  if (scoped.serverNames.length > 0) {
    process.env.MCP_DIRECT_TOOLS = "__none__";
    process.env.BOSSMODE_MCP_CONFIG_STRICT = "1";
    process.env.PI_CODING_AGENT_DIR = runtimeDir;
  }
  return { enabled: true, adapterPath, configPath: scoped.configPath, runtimeDir, serverNames: scoped.serverNames, dispose: scoped.dispose };
}

export function assertHostedMcpLoaded(loader: ResourceLoader): void {
  const extension = loader.getExtensions().extensions.find(entry => entry.path === "<inline:pi-mcp-adapter>");
  if (!extension?.tools.has("mcp")) throw new Error("Hosted MCP extension failed to load");
}

export async function bindMcpExtension(session: AgentSession, opts: { configPath: string; agent: string }): Promise<void> {
  try {
    session.extensionRunner.setFlagValue("mcp-config", opts.configPath);
    await session.bindExtensions({
      mode: "print",
      onError: (err) => logger.warn("runtime:pi-sdk", "mcp extension error", {
        agent: opts.agent,
        event: err.event,
        extensionPath: err.extensionPath,
        error: err.error,
      }),
    });
  } catch (err: any) {
    logger.warn("runtime:pi-sdk", "mcp extension bind failed", { agent: opts.agent, error: err.message || String(err) });
    throw err;
  }
}
import { exportPiConfigForMember, resolvePiAgentDir } from "../../config/pi-adapt/credentials.js";
import type { AgentMemberConfig } from "../../kernel/types.js";

export interface FinalMemberSystemPromptArgs {
  /** Scope-shaped id exactly as the runtime passes it (room:<id> / dm:<memberId>). */
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
  // the skills section when any skills loaded (pi ≥0.84 passes the reading tool).
  prompt += formatSkillsForPrompt(skills, "read");
  prompt += `\nCurrent working directory: ${args.cwd.replace(/\\/g, "/")}\n`;
  return prompt;
}
