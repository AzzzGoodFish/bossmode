import { describe, it, expect, beforeAll, vi } from "vitest";

let isResetSessionCommand: typeof import("../../web/src/components/AgentTab").isResetSessionCommand;
let buildResetSessionConfirmMessage: typeof import("../../web/src/components/AgentTab").buildResetSessionConfirmMessage;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  ({ isResetSessionCommand, buildResetSessionConfirmMessage } = await import("../../web/src/components/AgentTab"));
});

describe("reset session command helpers", () => {
  it("matches only the exact /reset-session command", () => {
    expect(isResetSessionCommand("/reset-session")).toBe(true);
    expect(isResetSessionCommand("  /reset-session  ")).toBe(true);
    expect(isResetSessionCommand("/reset-session now")).toBe(false);
    expect(isResetSessionCommand("please /reset-session")).toBe(false);
    expect(isResetSessionCommand("/Reset-Session")).toBe(false);
  });

  it("builds a confirm message with room and agent scope", () => {
    expect(buildResetSessionConfirmMessage("room-123", "architect")).toContain("@architect");
    expect(buildResetSessionConfirmMessage("room-123", "architect")).toContain("room room-123");
    expect(buildResetSessionConfirmMessage("room-123", "architect")).toContain("set the agent cursor to null");
    expect(buildResetSessionConfirmMessage("room-123", "architect")).toContain("keep room messages and activity history");
  });
});
