import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { BossmodeResourceLoader, PiSdkAgentHandle, resolvePiSystemPromptSources } from "../../src/engine/runtime/pi-sdk.js";

// Real installed SDK, local in-memory session only. No provider calls or credentials.
describe("real SDK prompt refresh", () => {
  it("rebuilds the SDK base prompt while preserving active tools and existing messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bossmode-prompt-refresh-"));
    const settings = SettingsManager.inMemory();
    const sources = resolvePiSystemPromptSources({ agentPrompt: "old identity", appendSystemPrompt: ["old roster"] });
    const loader = new BossmodeResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: sources.systemPrompt, appendSystemPrompt: sources.appendSystemPrompt,
    }, sources);
    const manager = SessionManager.inMemory(dir);
    const message = { role: "user" as const, content: "existing history", timestamp: 1 };
    manager.appendMessage(message);
    const { session } = await createAgentSession({
      sessionManager: manager, settingsManager: settings, cwd: dir, agentDir: dir,
      resourceLoader: loader, modelRuntime: {} as ModelRuntime,
      tools: ["read"], thinkingLevel: "off",
      model: { id: "test-model", provider: "test-provider", api: "test-api", reasoning: false } as any,
    });
    try {
      const history = [...manager.getEntries()];
      const sessionId = session.sessionId;
      const activeTools = session.getActiveToolNames();
      const reload = vi.spyOn(loader, "reload");
      const abort = vi.spyOn(session, "abort");
      const reset = vi.spyOn(manager, "resetLeaf");
      const handle = new PiSdkAgentHandle(
        session, {} as any, {} as any, loader, settings, [], activeTools,
        { model: "test/model", thinkingLevel: "off", systemPrompt: "old identity", skills: [], extensions: [] },
        [], { roomId: "room-local", agentName: "old-name", roomMembers: ["old-name"], memberId: "mem-stable" },
      );

      expect(session.systemPrompt).toContain("old identity");
      handle.refreshPrompt({ agentPrompt: "new identity", appendSystemPrompt: ["new roster"] });

      expect(session.systemPrompt).toContain("new identity");
      expect(session.systemPrompt).toContain("new roster");
      expect(session.systemPrompt).not.toContain("old identity");
      expect(session.systemPrompt).not.toContain("old roster");
      expect(session.getActiveToolNames()).toEqual(activeTools);
      expect(session.sessionId).toBe(sessionId);
      expect(session.state.messages).toEqual([message]);
      expect(manager.getEntries()).toEqual(history);
      expect(reload).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();

      // Resource reload cannot restore the initial SDK prompt source over the override.
      loader.setPromptSources(resolvePiSystemPromptSources({ agentPrompt: "explicit reload identity", appendSystemPrompt: [] }));
      await loader.reload();
      session.setActiveToolsByName(activeTools);
      expect(session.systemPrompt).toContain("explicit reload identity");
      expect(session.systemPrompt).not.toContain("old identity");
      expect(session.systemPrompt).not.toContain("new roster");
    } finally {
      await session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
