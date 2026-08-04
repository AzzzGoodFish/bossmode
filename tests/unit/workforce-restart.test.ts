import { describe, it, expect, vi, beforeEach } from "vitest";


vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

const routes = new Map<string, any>();
const sendJsonMock = vi.fn();
const destroyInstanceMock = vi.fn();
const getMemberMock = vi.fn();
const loggerErrorMock = vi.fn();
const latestMessageIdMock = vi.fn(() => "m-last");
const setCursorMock = vi.fn();

vi.mock("../../src/api/index.js", () => ({
  addRoute: vi.fn((method: string, path: string, handler: any) => {
    routes.set(`${method} ${path}`, handler);
  }),
  sendJson: sendJsonMock,
  parseBody: vi.fn(),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinitions: vi.fn(() => []),
  loadAgentDefinition: vi.fn(() => null),
  saveAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => true),
  loadAgentTemplates: vi.fn(() => []),
  getAgentsDir: vi.fn(() => "/tmp"),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  loadSkillDefinitions: vi.fn(() => []),
  loadSkillDefinition: vi.fn(() => null),
  saveSkillDefinition: vi.fn(),
  deleteSkillDefinition: vi.fn(() => true),
  loadSkillTemplates: vi.fn(() => []),
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  loadMembers: vi.fn(() => []),
  getMember: getMemberMock,
  saveMember: vi.fn(),
  deleteMember: vi.fn(() => true),
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  getMemberInstances: vi.fn(() => []),
  destroyInstance: destroyInstanceMock,
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  getLatestMessageId: (...args: any[]) => latestMessageIdMock(...args),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  setCursor: (...args: any[]) => setCursorMock(...args),
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

vi.mock("../../src/shared/frontmatter.js", () => ({
  parseFrontmatter: vi.fn(() => ({ meta: {}, body: "" })),
}));

describe("POST /api/members/:id/restart", () => {
  beforeEach(async () => {
    vi.resetModules();
    routes.clear();
    sendJsonMock.mockReset();
    destroyInstanceMock.mockReset();
    getMemberMock.mockReset();
    loggerErrorMock.mockReset();
    latestMessageIdMock.mockReset();
    setCursorMock.mockReset();

    await import("../../src/api/workforce.js");
  });

  it("returns 400 when roomId is missing", async () => {
    const handler = routes.get("POST /api/members/:id/restart");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });

    await handler({ url: "/api/members/m1/restart" } as any, {} as any, { id: "m1" });

    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, { error: "member and roomId required" });
    expect(destroyInstanceMock).not.toHaveBeenCalled();
    expect(setCursorMock).not.toHaveBeenCalled();
  });

  it("destroys, updates cursor to latest, and does not activate", async () => {
    const handler = routes.get("POST /api/members/:id/restart");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });

    await handler({ url: "/api/members/m1/restart?roomId=room-1" } as any, {} as any, { id: "m1" });

    expect(destroyInstanceMock).toHaveBeenCalledWith("room-1", "pm");
    expect(setCursorMock).toHaveBeenCalledWith("room-1", "pm", "m-last");
    expect(latestMessageIdMock).toHaveBeenCalledWith("room-1");
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        message: "Instance restarted. Next activation will wait for new messages.",
      }),
    );
  });

  it("does not require activation side effects", async () => {
    const handler = routes.get("POST /api/members/:id/restart");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });

    await handler({ url: "/api/members/m1/restart?roomId=room-1" } as any, {} as any, { id: "m1" });
    await Promise.resolve();

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});
