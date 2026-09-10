import { beforeAll, describe, expect, it, vi } from "vitest";

let contactDisplayState: typeof import("../../web/src/components/MemberPickerDialog.js").contactDisplayState;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  ({ contactDisplayState } = await import("../../web/src/components/MemberPickerDialog.js"));
});

describe("Create Room contact authority display state", () => {
  it("keeps loading distinct from empty", () => {
    expect(contactDisplayState({ status: "loading" })).toBe("loading");
  });

  it("keeps load errors distinct from empty even with zero contacts", () => {
    expect(contactDisplayState({ status: "error", message: "Offline" })).toBe("error");
  });

  it("shows empty only after a successful zero-item read", () => {
    expect(contactDisplayState({ status: "ready", contacts: [] })).toBe("empty");
  });

  it("shows contact choices after Retry succeeds", () => {
    expect(contactDisplayState({ status: "error", message: "Offline" })).toBe("error");
    expect(contactDisplayState({ status: "loading" })).toBe("loading");
    expect(contactDisplayState({ status: "ready", contacts: [{ id: "mem-1", name: "言 实", agent: "", thinkingLevel: "medium" }] })).toBe("items");
  });
});
