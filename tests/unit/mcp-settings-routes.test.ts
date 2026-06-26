import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const routes = new Map<string, any>();
const sendJsonMock = vi.fn();
const parseBodyMock = vi.fn();
const readConfigMock = vi.fn();
const writeConfigMock = vi.fn();
let dir: string;
let config: any;

vi.mock("../../src/api/index.js", () => ({
  addRoute: vi.fn((method: string, path: string, handler: any) => {
    routes.set(`${method} ${path}`, handler);
  }),
  sendJson: sendJsonMock,
  parseBody: parseBodyMock,
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  readConfig: readConfigMock,
  writeConfig: writeConfigMock,
}));

describe("MCP settings routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    routes.clear();
    sendJsonMock.mockReset();
    parseBodyMock.mockReset();
    readConfigMock.mockReset();
    writeConfigMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "bossmode-mcp-settings-"));
    config = { auth: { username: "u", passwordHash: "h" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, mcp: { enabled: false } };
    readConfigMock.mockReturnValue(config);

    await import("../../src/api/mcp.js");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves valid MCP JSON and enable state", async () => {
    parseBodyMock.mockResolvedValue({
      enabled: true,
      configText: JSON.stringify({ mcpServers: { playwright: { url: "http://10.8.0.24:8931/mcp" } } }),
    });

    const handler = routes.get("PUT /api/settings/mcp");
    await handler({} as any, {} as any, {});

    expect(writeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ mcp: { enabled: true } }));
    const savedPath = join(dir, "mcp", "mcp.json");
    expect(existsSync(savedPath)).toBe(true);
    expect(JSON.parse(readFileSync(savedPath, "utf-8"))).toEqual({ mcpServers: { playwright: { url: "http://10.8.0.24:8931/mcp" } } });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ enabled: true, serverCount: 1, savedServerCount: 1 }));
  });

  it("rejects invalid JSON without persisting config", async () => {
    parseBodyMock.mockResolvedValue({ enabled: true, configText: "{" });

    const handler = routes.get("PUT /api/settings/mcp");
    await handler({} as any, {} as any, {});

    expect(writeConfigMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "mcp", "mcp.json"))).toBe(false);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ error: expect.any(String) }));
  });

  it("redacts secret-like MCP fields in API responses", async () => {
    parseBodyMock.mockResolvedValue({
      enabled: true,
      configText: JSON.stringify({ mcpServers: { private: { url: "https://example.test/mcp", headers: { Authorization: "Bearer secret" }, env: { API_KEY: "secret" } } } }),
    });

    const put = routes.get("PUT /api/settings/mcp");
    await put({} as any, {} as any, {});

    const response = sendJsonMock.mock.calls.at(-1)?.[2];
    expect(response.configText).toContain("[REDACTED]");
    expect(response.configText).not.toContain("Bearer secret");
    expect(response.configText).not.toContain("API_KEY");
  });
});
