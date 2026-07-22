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

describe("Sidebar domainOf — team layer", () => {
  it("routes team pages into the team domain", () => {
    expect(domainOf({ type: "team", name: null })).toBe("team");
    expect(domainOf({ type: "team", name: "product-dev" })).toBe("team");
    expect(domainOf({ type: "agent", name: null })).toBe("team");
    expect(domainOf({ type: "skill", name: "x" })).toBe("team");
  });

  it("keeps rooms / library / settings domains unchanged", () => {
    expect(domainOf({ type: "room", id: "r1" })).toBe("rooms");
    expect(domainOf({ type: "knowledge" })).toBe("library");
    expect(domainOf({ type: "settings", section: "models" })).toBe("system");
    expect(domainOf(null)).toBe("rooms");
  });
});
