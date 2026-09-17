import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { readMcpConfigText, type MaterializedMcpConfig } from "../../src/member/mcp.js";

let fixture: ReturnType<typeof coreFixture>;
let materials: MaterializedMcpConfig[];
describe("mcp-settings helpers", () => {
  beforeEach(() => { fixture = coreFixture(); materials = []; });
  afterEach(() => {
    for (const material of materials) {
      material.dispose();
      expect(existsSync(material.configPath)).toBe(false);
    }
    fixture.close();
  });

  it("writes scoped config with only assigned servers and drops imports", async () => {
    const { writeMcpConfig, writeScopedMcpConfig } = await import("../../src/member/mcp.js");
    writeMcpConfig({
      imports: ["vscode"],
      settings: { timeout: 1000 },
      mcpServers: {
        playwright: { url: "http://127.0.0.1:8931/mcp" },
        github: { url: "http://127.0.0.1:8932/mcp" },
        invalid: {},
        badUrl: { url: "not a url" },
      },
    });

    const scoped = writeScopedMcpConfig({ roomId: "room/one", memberName: "developer", serverNames: ["playwright", "invalid", "badUrl", "missing"] });
    materials.push(scoped);
    expect(scoped.serverNames).toEqual(["playwright"]);
    const saved = JSON.parse(readFileSync(scoped.configPath, "utf-8"));
    expect(Object.keys(saved.mcpServers)).toEqual(["playwright"]);
    expect(saved.mcpServers.github).toBeUndefined();
    expect(saved.imports).toBeUndefined();
    expect(saved.settings).toEqual({ timeout: 1000 });
  });

  it("returns only assignable MCP server names", async () => {
    const { getAssignableMcpServerNames } = await import("../../src/member/mcp.js");
    expect(getAssignableMcpServerNames({
      mcpServers: {
        http: { url: "http://127.0.0.1:8931/mcp" },
        https: { url: "https://example.test/mcp" },
        stdio: { command: "node", args: ["server.mjs"] },
        missing: {},
        badUrl: { url: "not a url" },
        badProtocol: { url: "ftp://example.test/mcp" },
        emptyCommand: { command: "   " },
      },
    })).toEqual(["http", "https", "stdio"]);
  });

  it("forces deferred MCP capabilities off in scoped configs", async () => {
    const { writeMcpConfig, writeScopedMcpConfig } = await import("../../src/member/mcp.js");
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
    materials.push(scoped);
    const saved = JSON.parse(readFileSync(scoped.configPath, "utf-8"));
    expect(JSON.parse(readMcpConfigText()).settings.sampling).toBe(true);
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
