import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const readConfigMock = vi.fn();
const listRoomsMock = vi.fn();
const getCursorsMock = vi.fn();
const setCursorMock = vi.fn();

vi.mock("../../src/shared/config.js", () => ({
  readConfig: () => readConfigMock(),
  ensureBossmodeDir: vi.fn(),
  seedTemplates: vi.fn(),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  listRooms: () => listRoomsMock(),
  getCursors: (roomId: string) => getCursorsMock(roomId),
  setCursor: (roomId: string, agentName: string, cursor: string | null) => setCursorMock(roomId, agentName, cursor),
}));

vi.mock("../../src/knowledge/migration.js", () => ({ runKnowledgeMigration: vi.fn() }));
vi.mock("../../src/engine/agent-manager.js", () => ({
  initAgentManager: vi.fn(),
  shutdownAll: vi.fn(async () => {}),
  getActiveInstanceCount: vi.fn(() => 0),
  activateAgent: vi.fn(async () => {}),
  activateAll: vi.fn(async () => {}),
}));
vi.mock("../../src/communication/router.js", () => ({ initRouter: vi.fn(() => () => {}) }));
vi.mock("../../src/engine/summarizer.js", () => ({ initAutoSummary: vi.fn(() => () => {}) }));
vi.mock("../../src/communication/ws.js", () => ({
  createWebSocketServer: vi.fn(),
  shutdownWebSocket: vi.fn(),
}));
vi.mock("../../src/engine/runtime/registry.js", () => ({
  RuntimeRegistry: class {
    register() {}
  },
}));
vi.mock("../../src/engine/runtime/pi-cli.js", () => ({ PiCliRuntime: class {} }));
vi.mock("../../src/engine/runtime/claude-cli.js", () => ({ ClaudeCliRuntime: class {} }));
vi.mock("../../src/api/index.js", () => ({ handleApiRequest: vi.fn(async () => false) }));

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({
    on: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
    close: vi.fn((cb?: () => void) => cb?.()),
  })),
}));

describe("server startup cursor reset when session resume is disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets all stored room cursors to null", async () => {
    readConfigMock.mockReturnValue({ runtime: { sessionResume: false } });
    listRoomsMock.mockReturnValue([{ id: "room-1" }, { id: "room-2" }]);
    getCursorsMock.mockImplementation((roomId: string) => {
      if (roomId === "room-1") return { pm: "m1", architect: "m2" };
      return { qa: "m3" };
    });

    const { startServer } = await import("../../src/server/index.js");
    await startServer({ host: "127.0.0.1", port: 18080 });

    expect(setCursorMock).toHaveBeenCalledTimes(3);
    expect(setCursorMock).toHaveBeenCalledWith("room-1", "pm", null);
    expect(setCursorMock).toHaveBeenCalledWith("room-1", "architect", null);
    expect(setCursorMock).toHaveBeenCalledWith("room-2", "qa", null);
  });
});
