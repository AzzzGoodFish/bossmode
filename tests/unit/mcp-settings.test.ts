import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
}));

describe("mcp-settings helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), "bossmode-mcp-settings-helper-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes scoped config with only assigned servers and drops imports", async () => {
    const { writeMcpConfig, writeScopedMcpConfig } = await import("../../src/shared/mcp-settings.js");
    writeMcpConfig({
      imports: ["vscode"],
      settings: { timeout: 1000 },
      mcpServers: {
        playwright: { url: "http://127.0.0.1:8931/mcp" },
        github: { url: "http://127.0.0.1:8932/mcp" },
      },
    });

    const scoped = writeScopedMcpConfig({ roomId: "room/one", memberName: "developer", serverNames: ["playwright", "missing"] });
    expect(scoped.serverNames).toEqual(["playwright"]);
    const saved = JSON.parse(readFileSync(scoped.configPath, "utf-8"));
    expect(Object.keys(saved.mcpServers)).toEqual(["playwright"]);
    expect(saved.mcpServers.github).toBeUndefined();
    expect(saved.imports).toBeUndefined();
    expect(saved.settings).toEqual({ timeout: 1000 });
  });

  it("forces deferred MCP capabilities off in scoped configs", async () => {
    const { writeMcpConfig, writeScopedMcpConfig } = await import("../../src/shared/mcp-settings.js");
    writeMcpConfig({
      settings: {
        timeout: 1000,
        sampling: true,
        samplingAutoApprove: true,
        elicitation: true,
        directTools: true,
        nested: { sampling: { enabled: true }, elicitation: { mode: "url" } },
      },
      mcpServers: {
        playwright: { url: "http://127.0.0.1:8931/mcp", directTools: true },
      },
    });

    const scoped = writeScopedMcpConfig({ roomId: "room/one", memberName: "developer", serverNames: ["playwright"] });
    const saved = JSON.parse(readFileSync(scoped.configPath, "utf-8"));
    expect(saved.settings.timeout).toBe(1000);
    expect(saved.settings.sampling).toBe(false);
    expect(saved.settings.samplingAutoApprove).toBe(false);
    expect(saved.settings.elicitation).toBe(false);
    expect(saved.settings.directTools).toBe(false);
    expect(saved.settings.nested.sampling).toBe(false);
    expect(saved.settings.nested.elicitation).toBe(false);
    expect(saved.mcpServers.playwright.directTools).toBe(false);
  });
});
