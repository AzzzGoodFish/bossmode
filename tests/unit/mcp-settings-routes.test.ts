import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupTestWorkspace, getTestWorkspace, createTestServer, closeTestServer,
  loginAndGetToken, jsonRequest, type TestServer,
} from "../helpers/test-server.js";
import { readConfig, writeConfig } from "../../src/config/config.js";
import { readMcpConfigText, writeMcpConfig } from "../../src/shared/mcp-settings.js";

setupTestWorkspace();
let server: TestServer;
let token: string;
beforeAll(async () => { server = await createTestServer(); token = await loginAndGetToken(server.port); });
afterAll(async () => { await closeTestServer(server); });
beforeEach(() => {
  writeConfig({ ...readConfig(), mcp: { enabled: false } });
  writeMcpConfig({ mcpServers: {} });
});
const path = "/api/settings/mcp";
function put(body: unknown) { return jsonRequest(server.port, "PUT", path, { token, body }); }
async function get() {
  const response = await jsonRequest(server.port, "GET", path, { token });
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

describe("MCP settings HTTP with SQL authority", () => {
  it("saves valid MCP JSON and enable state, returning database status after reopen", async () => {
    const config = { mcpServers: { playwright: { url: "https://mcp.example.test/mcp" } } };
    const response = await put({ enabled: true, configText: JSON.stringify(config) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ enabled: true, serverCount: 1, savedServerCount: 1 });
    getTestWorkspace().reopen();
    expect(readConfig().mcp?.enabled).toBe(true);
    expect(JSON.parse(readMcpConfigText())).toEqual(config);
    const status = await get();
    expect(status).toMatchObject({ enabled: true, configPath: getTestWorkspace().path, serverCount: 1,
      sources: [{ label: "Bossmode database", exists: true, serverCount: 1 }] });
    expect(JSON.parse(status.configText)).toEqual(config);
    expect(existsSync(join(getTestWorkspace().root, "mcp", "mcp.json"))).toBe(false);
  });

  it.each(["{", "[]", '{"mcpServers":[]}'])("rejects invalid JSON/object %s without changing either stored value", async configText => {
    const before = readMcpConfigText();
    const config = readConfig();
    const response = await put({ enabled: true, configText });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) });
    expect(readConfig()).toEqual(config);
    expect(readMcpConfigText()).toBe(before);
  });

  it("redacts secret-like MCP fields in PUT and GET responses", async () => {
    const response = await put({ enabled: true, configText: JSON.stringify({ mcpServers: {
      private: { url: "https://example.test/mcp", bearerToken: "token-secret",
        headers: { Authorization: "Bearer secret" }, env: { API_KEY: "env-secret" } },
    } }) });
    expect(response.status).toBe(200);
    for (const status of [JSON.parse(response.body), await get()]) {
      expect(status.configText).toContain("[REDACTED]");
      for (const secret of ["token-secret", "Bearer secret", "API_KEY", "env-secret"]) {
        expect(JSON.stringify(status)).not.toContain(secret);
      }
    }
  });

  it("preserves existing secrets when a redacted response is saved back with non-secret edits", async () => {
    const secrets = { bearerToken: "token-secret", headers: { Authorization: "Bearer secret" }, env: { API_KEY: "env-secret" } };
    const initial = await put({ enabled: true, configText: JSON.stringify({ mcpServers: {
      private: { url: "https://example.test/mcp", ...secrets },
    } }) });
    expect(initial.status).toBe(200);
    const edited = JSON.parse((await get()).configText);
    edited.mcpServers.private.url = "https://changed.example.test/mcp";
    const response = await put({ configText: JSON.stringify(edited) });
    expect(response.status).toBe(200);
    getTestWorkspace().reopen();
    expect(JSON.parse(readMcpConfigText()).mcpServers.private).toEqual({
      url: "https://changed.example.test/mcp", ...secrets,
    });
    expect(readConfig().mcp?.enabled).toBe(true);
    expect(response.body).not.toContain("token-secret");
  });

  it("rejects unauthenticated writes without changing SQL", async () => {
    const response = await jsonRequest(server.port, "PUT", path, { body: { enabled: true } });
    expect(response.status).toBe(401);
    expect(readConfig().mcp?.enabled).toBe(false);
  });
});
