import { describe, it, expect, vi, beforeEach } from "vitest";

const routes = new Map<string, any>();
const sendJsonMock = vi.fn();
const abortMemberMock = vi.fn();
const compactMemberByIdMock = vi.fn();
const resetMemberSessionMock = vi.fn();
const restartMemberMock = vi.fn();
const getMemberMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock("../../src/api/index.js", () => ({
  addRoute: vi.fn((method: string, path: string, handler: any) => {
    routes.set(`${method} ${path}`, handler);
  }),
  sendJson: sendJsonMock,
  parseBody: vi.fn(),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  loadSkillDefinitions: vi.fn(() => []),
  loadSkillDefinition: vi.fn(() => null),
  saveSkillDefinition: vi.fn(),
  deleteSkillDefinition: vi.fn(() => true),
  loadSkillTemplates: vi.fn(() => []),
}));


vi.mock("../../src/engine/agent-manager.js", () => ({
  getMemberInstances: vi.fn(() => []),
  abortMember: (...args: any[]) => abortMemberMock(...args),
  compactMemberById: (...args: any[]) => compactMemberByIdMock(...args),
  resetMemberSession: (...args: any[]) => resetMemberSessionMock(...args),
  restartMember: (...args: any[]) => restartMemberMock(...args),
}));

vi.mock("../../src/workspace/member-registry.js", () => ({
  getMember: (...args: any[]) => getMemberMock(...args),
}));

vi.mock("../../src/kernel/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    error: loggerErrorMock,
  },
}));

vi.mock("../../src/kernel/frontmatter.js", () => ({
  parseFrontmatter: vi.fn(() => ({ meta: {}, body: "" })),
}));

// ① B5: stop / compact / reset / restart are member-level interfaces — the
// request names the member and nothing else; no room query is accepted.
describe("member-level operation routes (batch 1 B5)", () => {
  beforeEach(async () => {
    vi.resetModules();
    routes.clear();
    for (const fn of [sendJsonMock, abortMemberMock, compactMemberByIdMock, resetMemberSessionMock, restartMemberMock, getMemberMock, loggerInfoMock, loggerErrorMock]) fn.mockReset();
    await import("../../src/api/workforce.js");
  });

  it("restart drops the member's runtime without a room query", async () => {
    const handler = routes.get("POST /api/members/:id/restart");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });
    restartMemberMock.mockReturnValue({ ok: true, message: "Member restarted. Next activation will start a fresh runtime." });

    await handler({ url: "/api/members/m1/restart" } as any, {} as any, { id: "m1" });

    expect(restartMemberMock).toHaveBeenCalledWith("m1");
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true }),
    );
  });

  it("stop aborts through the member interface and reports honestly", async () => {
    const handler = routes.get("POST /api/members/:id/stop");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });
    abortMemberMock.mockReturnValue({ ok: true, action: "aborted" });

    await handler({ url: "/api/members/m1/stop" } as any, {} as any, { id: "m1" });

    expect(abortMemberMock).toHaveBeenCalledWith("m1");
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { ok: true, action: "aborted" });
  });

  it("reset clears the member session from the member interface", async () => {
    const handler = routes.get("POST /api/members/:id/reset");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });
    resetMemberSessionMock.mockReturnValue({ ok: true, message: "Session reset. Next activation will start fresh." });

    await handler({ url: "/api/members/m1/reset" } as any, {} as any, { id: "m1" });

    expect(resetMemberSessionMock).toHaveBeenCalledWith("m1");
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ ok: true }));
  });

  it("compact follows the member and surfaces failures as 400", async () => {
    const handler = routes.get("POST /api/members/:id/compact");
    getMemberMock.mockReturnValue({ id: "m1", name: "pm", runtime: "pi-cli" });
    compactMemberByIdMock.mockResolvedValue({ ok: true, action: "compacted" });

    await handler({ url: "/api/members/m1/compact" } as any, {} as any, { id: "m1" });
    expect(compactMemberByIdMock).toHaveBeenCalledWith("m1");
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { ok: true, action: "compacted" });

    sendJsonMock.mockReset();
    compactMemberByIdMock.mockRejectedValue(new Error("nothing to compact"));
    await handler({ url: "/api/members/m1/compact" } as any, {} as any, { id: "m1" });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, { error: "compact_failed", message: "nothing to compact" });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("rejects unknown members before the engine is touched", async () => {
    getMemberMock.mockReturnValue(null);
    for (const action of ["stop", "compact", "reset", "restart"]) {
      const handler = routes.get(`POST /api/members/:id/${action}`);
      await handler({ url: `/api/members/missing/${action}` } as any, {} as any, { id: "missing" });
      expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 404, { error: "Member not found" });
    }
    expect(abortMemberMock).not.toHaveBeenCalled();
    expect(compactMemberByIdMock).not.toHaveBeenCalled();
    expect(resetMemberSessionMock).not.toHaveBeenCalled();
    expect(restartMemberMock).not.toHaveBeenCalled();
  });
});
