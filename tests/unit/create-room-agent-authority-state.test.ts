import { beforeAll, describe, expect, it, vi } from "vitest";

let agentAuthorityDisplayState: typeof import("../../web/src/components/CreateRoomDialog.js").agentAuthorityDisplayState;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  ({ agentAuthorityDisplayState } = await import("../../web/src/components/CreateRoomDialog.js"));
});

describe("Create Room Agent authority display state", () => {
  it("keeps loading distinct from empty", () => {
    expect(agentAuthorityDisplayState("loading", 0)).toBe("loading");
  });

  it("keeps load errors distinct from empty even with zero Agents", () => {
    expect(agentAuthorityDisplayState("error", 0)).toBe("error");
  });

  it("shows empty only after a successful zero-item read", () => {
    expect(agentAuthorityDisplayState("ready", 0)).toBe("empty");
  });

  it("shows Agent choices after Retry succeeds", () => {
    expect(agentAuthorityDisplayState("error", 0)).toBe("error");
    expect(agentAuthorityDisplayState("loading", 0)).toBe("loading");
    expect(agentAuthorityDisplayState("ready", 2)).toBe("items");
  });
});
