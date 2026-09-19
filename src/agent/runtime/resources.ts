import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentResourceSnapshot } from "../types.js";
import { logger } from "../../kernel/logger.js";
import { DefaultResourceLoader, type ResourceLoader, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
export type McpFactoryLoader=(adapterPath:string)=>Promise<{name:string;factory:ExtensionFactory}>;
let mcpFactoryLoader:McpFactoryLoader|undefined;
export function configureMcpFactoryLoader(loader:McpFactoryLoader|undefined):void{mcpFactoryLoader=loader;}
export function loadMcpFactory(adapterPath:string){if(!mcpFactoryLoader)throw new Error("MCP runtime is not connected");return mcpFactoryLoader(adapterPath);}
export { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
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
export class BossmodeResourceLoader extends DefaultResourceLoader {
  private promptSources: ReturnType<typeof resolvePiSystemPromptSources>;
  constructor(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    sources: ReturnType<typeof resolvePiSystemPromptSources>,
  ) {
    super(options);
    this.promptSources={...sources,appendSystemPrompt:[...sources.appendSystemPrompt]};
  }
  setPromptSources(sources: ReturnType<typeof resolvePiSystemPromptSources>): void {
    this.promptSources = { ...sources, appendSystemPrompt: [...sources.appendSystemPrompt] };
  }
  getSystemPrompt(): string | undefined {
    return this.promptSources.systemPrompt;
  }
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
export function materializeMcpRuntimeSettings(
  resource: AgentResourceSnapshot["mcp"],
): McpRuntimeSettings {
  if (!existsSync(resource.adapterPath)) {
    throw new Error(`MCP adapter not found at ${resource.adapterPath}. Run git submodule update --init --recursive.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "bossmode-mcp-runtime-"));
  try {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify(resource.config), { mode: 0o600 });
    if (resource.serverNames.length > 0) {
      process.env.MCP_DIRECT_TOOLS = "__none__";
      process.env.BOSSMODE_MCP_CONFIG_STRICT = "1";
      process.env.PI_CODING_AGENT_DIR = resource.runtimeDir;
    }
    return {
      enabled: true,
      adapterPath: resource.adapterPath,
      configPath,
      runtimeDir: resource.runtimeDir,
      serverNames: [...resource.serverNames],
      dispose: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
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
