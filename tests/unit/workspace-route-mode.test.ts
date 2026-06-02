import { beforeAll, describe, expect, it, vi } from "vitest";

let workspaceResourceRouteMode: typeof import("../../web/src/pages/Layout").workspaceResourceRouteMode;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  ({ workspaceResourceRouteMode } = await import("../../web/src/pages/Layout"));
});

describe("workspace resource route mode", () => {
  it("treats null as list, __new__ as create, and names as detail", () => {
    expect(workspaceResourceRouteMode(null)).toBe("list");
    expect(workspaceResourceRouteMode("__new__")).toBe("create");
    expect(workspaceResourceRouteMode("pm")).toBe("detail");
  });
});
