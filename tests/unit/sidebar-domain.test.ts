import { beforeAll, describe, expect, it, vi } from "vitest";

let domainOf: typeof import("../../web/src/components/Sidebar.js").domainOf;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  ({ domainOf } = await import("../../web/src/components/Sidebar.js"));
});

describe("Sidebar domainOf — 0.20 merged chat IA", () => {
  it("routes all chat-family pages into the chats domain", () => {
    expect(domainOf({ type: "chats" })).toBe("chats");
    expect(domainOf({ type: "contacts" })).toBe("chats");
    expect(domainOf({ type: "dm", memberId: "mem_1" })).toBe("chats");
    expect(domainOf({ type: "member-create" })).toBe("chats");
    expect(domainOf({ type: "member-settings", memberId: "mem_1" })).toBe("chats");
    expect(domainOf({ type: "room", id: "r1" })).toBe("chats");
    expect(domainOf(null)).toBe("chats");
  });

  it("routes system settings to its own panel; retired resource pages fall back to chats", () => {
    // Templates/Skills/Library pages were removed in the identity rework (batch 2.5);
    // their legacy page types now fall through to the default chats domain.
    expect(domainOf({ type: "settings", section: "models" })).toBe("system");
    expect(domainOf({ type: "templates" })).toBe("chats");
    expect(domainOf({ type: "knowledge" })).toBe("chats");
  });
});
