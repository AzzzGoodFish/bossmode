import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupTestWorkspace, getTestWorkspace, createTestServer, closeTestServer,
  loginAndGetToken, jsonRequest, type TestServer,
} from "../helpers/test-server.js";
import { readConfig, writeConfig } from "../../src/shared/config.js";

setupTestWorkspace();
let server: TestServer;
let token: string;
beforeAll(async () => { server = await createTestServer(); token = await loginAndGetToken(server.port); });
afterAll(async () => { await closeTestServer(server); });
beforeEach(() => {
  writeConfig({ ...readConfig(), runtime: { sessionResume: true, codexTransport: "websocket-cached",
    websocketConnectTimeoutMs: 60000, httpIdleTimeoutMs: 120000 } });
});
const path = "/api/settings/runtime";
function put(body: unknown) { return jsonRequest(server.port, "PUT", path, { token, body }); }

describe("runtime settings HTTP with SQL authority", () => {
  it("clears httpIdleTimeoutMs when the client sends null", async () => {
    const original = readConfig();
    const response = await put({ httpIdleTimeoutMs: null });
    expect(response.status).toBe(200);
    const expected = { sessionResume: true, topicSeedMode: "fork", codexTransport: "websocket-cached", websocketConnectTimeoutMs: 60000 };
    expect(JSON.parse(response.body)).toEqual(expected);
    getTestWorkspace().reopen();
    const { httpIdleTimeoutMs: _, ...retained } = original.runtime!;
    expect(readConfig()).toEqual({ ...original, runtime: retained });
    const fetched = await jsonRequest(server.port, "GET", path, { token });
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toEqual(expected);
  });

  it("persists topicSeedMode toggle in both directions without changing other settings", async () => {
    const original = readConfig();
    for (const topicSeedMode of ["fresh", "fork"] as const) {
      const response = await put({ topicSeedMode });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).topicSeedMode).toBe(topicSeedMode);
      getTestWorkspace().reopen();
      expect(readConfig()).toEqual({ ...original, runtime: { ...original.runtime, topicSeedMode } });
    }
  });

  it.each([
    { sessionResume: "false" }, { topicSeedMode: "invalid" }, { codexTransport: "invalid" },
    { httpIdleTimeoutMs: -1 }, { websocketConnectTimeoutMs: "100" },
  ])("rejects invalid patch %j without persisting partial changes", async invalid => {
    const before = readConfig();
    const response = await put({ sessionResume: false, ...invalid });
    expect(response.status).toBe(400);
    expect(readConfig()).toEqual(before);
  });
});
