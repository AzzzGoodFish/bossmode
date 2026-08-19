import { beforeEach, describe, expect, it, vi } from "vitest";

const routes = new Map<string, any>();
const sendJsonMock = vi.fn();
const parseBodyMock = vi.fn();
const readConfigMock = vi.fn();
const writeConfigMock = vi.fn();

vi.mock("../../src/api/index.js", () => ({
  addRoute: vi.fn((method: string, path: string, handler: any) => {
    routes.set(`${method} ${path}`, handler);
  }),
  sendJson: sendJsonMock,
  parseBody: parseBodyMock,
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  getRegistry: vi.fn(() => null),
  invalidateModelCredentialProfile: vi.fn(),
}));

vi.mock("../../src/shared/config.js", () => ({
  readConfig: readConfigMock,
  writeConfig: writeConfigMock,
}));

vi.mock("../../src/engine/model-credentials.js", () => ({
  cancelOAuthLoginJob: vi.fn(),
  connectBuiltinProviderApiKey: vi.fn(),
  deleteModelCredentialProfile: vi.fn(),
  discoverModelCredentialModels: vi.fn(),
  getModelCredentialProfile: vi.fn(),
  getOAuthLoginJob: vi.fn(),
  listAvailableModels: vi.fn(() => []),
  listBuiltinModelProviders: vi.fn(() => []),
  listPublicModelCredentialProfiles: vi.fn(() => []),
  refreshModelCredentialProfileModels: vi.fn(),
  saveModelCredentialProfile: vi.fn(),
  startNativeOAuthConnection: vi.fn(),
  startOAuthLoginJob: vi.fn(),
  submitOAuthLoginJobInput: vi.fn(),
}));

describe("runtime settings routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    routes.clear();
    sendJsonMock.mockReset();
    parseBodyMock.mockReset();
    readConfigMock.mockReset();
    writeConfigMock.mockReset();

    await import("../../src/api/engine-routes.js");
  });

  it("clears httpIdleTimeoutMs when the client sends null", async () => {
    const config = {
      auth: { username: "u", passwordHash: "h" },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
      runtime: {
        sessionResume: true,
        codexTransport: "websocket-cached",
        websocketConnectTimeoutMs: 60000,
        httpIdleTimeoutMs: 120000,
      },
    };
    readConfigMock.mockReturnValue(config);
    parseBodyMock.mockResolvedValue({ httpIdleTimeoutMs: null });

    const handler = routes.get("PUT /api/settings/runtime");
    await handler({} as any, {} as any, {});

    expect(writeConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.not.objectContaining({ httpIdleTimeoutMs: expect.anything() }),
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      sessionResume: true,
      piBuiltinPrompt: false,
      topicSeedMode: "fork",
      codexTransport: "websocket-cached",
      websocketConnectTimeoutMs: 60000,
    });
  });

  it("persists piBuiltinPrompt toggle", async () => {
    const config = {
      auth: { username: "u", passwordHash: "h" },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
      runtime: { sessionResume: true },
    };
    readConfigMock.mockReturnValue(config);
    parseBodyMock.mockResolvedValue({ piBuiltinPrompt: true });

    const handler = routes.get("PUT /api/settings/runtime");
    await handler({} as any, {} as any, {});

    expect(writeConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ piBuiltinPrompt: true }),
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      piBuiltinPrompt: true,
      sessionResume: true,
    }));
  });

  it("persists topicSeedMode toggle", async () => {
    const config = {
      auth: { username: "u", passwordHash: "h" },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
      runtime: { sessionResume: true },
    };
    readConfigMock.mockReturnValue(config);
    parseBodyMock.mockResolvedValue({ topicSeedMode: "fresh" });

    const handler = routes.get("PUT /api/settings/runtime");
    await handler({} as any, {} as any, {});

    expect(writeConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ topicSeedMode: "fresh" }),
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      topicSeedMode: "fresh",
    }));
  });
});
